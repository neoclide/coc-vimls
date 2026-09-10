import { CodeAction, CodeActionKind, CodeActionProvider, commands, ExtensionContext, LanguageClient, languages, Range, services, window, workspace } from 'coc.nvim'
import { cachedServer, ensureServer, installedVersion, latestRelease, previousServer, selectServer } from './server'
import { executeVimScript, isVim9 } from './execute'
import { registerDiagnosticQuickfix } from './diagnostic'
import { switchServer } from './lifecycle'

let client: LanguageClient | undefined
let updating: Promise<void> | undefined
let active = false
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export async function checkWeeklyUpdate(context: ExtensionContext): Promise<void> {
  const config = workspace.getConfiguration('vimls')
  if (!config.get<boolean>('checkForUpdates', true) || config.get<string>('command', '')) return
  const lastCheck = context.globalState.get<number>('last_update_check', 0)
  const now = Date.now()
  if (now - lastCheck < ONE_WEEK_MS) return
  try {
    const release = await latestRelease()
    const currentVer = await installedVersion(context.storagePath)
    await context.globalState.update('last_update_check', now)
    if (active && workspace.getConfiguration('vimls').get<boolean>('checkForUpdates', true) && currentVer && currentVer !== release.tag_name) {
      const item = await window.showInformationMessage(
        `A new vimls-go release (${release.tag_name}) is available. Current version: ${currentVer}.`,
        'Update now'
      )
      if (active && item === 'Update now') {
        await commands.executeCommand('vimls.update')
      }
    }
  } catch {
    // Ignore network or GitHub API errors during background check
  }
}

export async function activate(context: ExtensionContext): Promise<void> {
  registerDiagnosticQuickfix(context)
  const config = workspace.getConfiguration('vimls')
  const serverOptions = { command: config.get<string>('command', '') || '', args: config.get<string[]>('args', []) }
  active = true
  let runtimepath = workspace.env.runtimepath.split(',')
  let lastError = ''
  let registered = false
  const current = new LanguageClient('vimls', 'vimls-go', serverOptions, {
    documentSelector: [{ language: 'vim', scheme: 'file' }, { language: 'vim', scheme: 'untitled' }],
    initializationOptions: () => ({
      runtimepath,
      configFiles: workspace.getConfiguration('vim').get<string[]>('configFiles', []),
    }),
    synchronize: { configurationSection: 'vim' },
    outputChannelName: 'vimls',
    initializationFailedHandler: error => {
      lastError = String(error)
      return false
    },
  })
  client = current
  const customCommand = serverOptions.command
  const register = () => {
    if (!registered) {
      registered = true
      context.subscriptions.push(services.registerLanguageClient(current))
    }
  }
  // Installation, restart and rollback share one operation to avoid stopping
  // a process while another command is changing its executable.
  const operate = (operation: () => Promise<void>): Promise<void> => {
    if (updating) return updating
    updating = operation().catch(error => {
      lastError = error instanceof Error ? error.message : String(error)
      current.outputChannel.appendLine(`vimls-go: ${lastError}`)
      void window.showErrorMessage(`vimls-go: ${lastError}. Use vimls.doctor for details and vimls.restart to retry.`)
      throw error
    }).finally(() => { updating = undefined })
    return updating
  }
  const start = async () => {
    serverOptions.command ||= await window.withProgress({ title: 'Installing vimls-go' }, () => ensureServer(context.storagePath))
    await current.start()
    register()
    lastError = ''
  }
  const managed = () => {
    if (customCommand || workspace.getConfiguration('vimls').get<string>('command', '')) {
      void window.showInformationMessage('vimls.command is configured; update that executable manually or clear vimls.command and reload the extension to use managed releases.')
      return false
    }
    return true
  }
  context.subscriptions.push(commands.registerCommand('vimls.update', () => {
    if (!managed()) return
    return operate(async () => {
      const command = await window.withProgress({ title: 'Updating vimls-go' }, () => ensureServer(context.storagePath, true))
      await switchServer(current, serverOptions, command, binary => selectServer(context.storagePath, binary))
      register()
      lastError = ''
      await window.showInformationMessage('vimls-go is up to date.')
    })
  }))
  context.subscriptions.push(commands.registerCommand('vimls.rollback', () => {
    if (!managed()) return
    return operate(async () => {
      const command = await previousServer(context.storagePath)
      if (!command) throw new Error('No previous managed installation is available')
      await switchServer(current, serverOptions, command, binary => selectServer(context.storagePath, binary))
      register()
      lastError = ''
      await window.showInformationMessage('Previous vimls-go installation restored.')
    })
  }))
  context.subscriptions.push(commands.registerCommand('vimls.restart', () => operate(async () => {
    await current.stop()
    await start()
    window.showMessage('vimls-go server restarted')
  })))

  context.subscriptions.push(commands.registerCommand('vimls.openOutput', () => {
    if (client) {
      client.outputChannel.show()
    } else {
      void commands.executeCommand('workspace.showOutput', 'vimls')
    }
  }))

  context.subscriptions.push(commands.registerCommand('vimls.executeSelected', async (uri?: string, range?: Range) => {
    let text = ''
    let doc = uri ? workspace.getDocument(uri) : undefined
    if (doc && range) {
      text = doc.textDocument.getText(range)
    }
    if (!text) {
      doc = await workspace.document
      if (!doc) return
      const r = await window.getSelectedRange('v')
      if (r) text = doc.textDocument.getText(r)
    }
    if (!text.trim()) return
    doc ??= await workspace.document

    try {
      const vim9 = isVim9(doc, text)
      const vimCommand = workspace.getConfiguration('vimls').get<string>('vimCommand', '') || 'vim'
      const res = await executeVimScript(workspace.nvim, text, vim9, {
        isNvim: workspace.isNvim,
        vimCommand,
      })
      if (res) {
        window.showMessage(res)
      } else {
        window.showMessage('Vim script executed successfully')
      }
      return res
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void window.showErrorMessage(`Failed to execute Vim script: ${message}`)
    }
  }))

  const codeActionProvider: CodeActionProvider = {
    provideCodeActions(document, range) {
      if (range.start.line === range.end.line && range.start.character === range.end.character) {
        return []
      }
      const text = document.getText(range)
      if (!text.trim()) return []
      const action: CodeAction = {
        title: 'Execute selected Vim script',
        kind: CodeActionKind.Empty,
        command: {
          title: 'Execute selected Vim script',
          command: 'vimls.executeSelected',
          arguments: [document.uri, range]
        }
      }
      return [action]
    }
  }

  context.subscriptions.push(languages.registerCodeActionProvider(
    [{ language: 'vim', scheme: 'file' }, { language: 'vim', scheme: 'untitled' }],
    codeActionProvider,
    'vimls'
  ))

  context.subscriptions.push(commands.registerCommand('vimls.doctor', async () => {
    const channel = current.outputChannel
    channel.appendLine('')
    channel.appendLine('=== vimls-go Doctor ===')
    channel.appendLine(`Status: ${client?.isRunning() ? 'running' : 'stopped'}`)
    const customCmd = workspace.getConfiguration('vimls').get<string>('command', '')
    channel.appendLine(`Custom Command: ${customCmd ? customCmd : '(none, using managed release)'}`)
    channel.appendLine(`Mode: ${customCommand ? 'custom executable' : 'managed release'}`)
    channel.appendLine(`Selected Binary: ${serverOptions.command || 'not installed'}`)
    channel.appendLine(`Running Binary: ${current.isRunning() ? serverOptions.command : 'not running'}`)
    channel.appendLine(`Running Version: ${current.isRunning() ? current.initializeResult?.serverInfo?.version || 'not reported by server' : 'not running'}`)
    channel.appendLine(`Arguments: ${JSON.stringify(serverOptions.args)}`)
    try {
      channel.appendLine(`Managed Cache Binary: ${(await cachedServer(context.storagePath)) || 'none'}`)
      channel.appendLine(`Managed Cache Version: ${(await installedVersion(context.storagePath)) || 'none'}${customCommand ? ' (not used by custom server)' : ''}`)
    } catch (error) {
      channel.appendLine(`Managed Cache Error: ${String(error)}`)
    }
    channel.appendLine(`Last Error: ${lastError || 'none'}`)
    channel.appendLine('Recovery: vimls.restart retries installation/startup; vimls.update installs the latest release; vimls.rollback restores the previous release.')
    channel.appendLine(`Platform: ${process.platform} (${process.arch})`)
    channel.appendLine(`Trace Level: ${workspace.getConfiguration('vimls').get<string>('trace.server', 'off')}`)
    const configFiles = workspace.getConfiguration('vim').get<string[]>('configFiles', [])
    channel.appendLine(`Config Files: ${JSON.stringify(configFiles)}`)
    const excludeRuntime = workspace.getConfiguration('vim').get<boolean>('suggest.excludeRuntimePath', false)
    channel.appendLine(`Suggest Exclude RuntimePath: ${String(excludeRuntime)}`)
    channel.appendLine(`Runtimepath Count: ${runtimepath.length}`)
    channel.appendLine('Runtimepath:')
    for (const p of runtimepath) {
      channel.appendLine(`  - ${p}`)
    }
    channel.show()
  }))

  workspace.watchOption('runtimepath', async (_oldValue: string, newValue: string) => {
    try {
      runtimepath = newValue.split(',')
      if (current.isRunning()) {
        await current.sendRequest('vimls/didChangeRuntimepath', { runtimepath })
      }
    } catch (error) {
      void window.showErrorMessage(`vimls-go: failed to update runtimepath: ${String(error)}`)
    }
  }, context.subscriptions)
  // Keep commands available even when the first installation or startup fails.
  await operate(start).catch(() => {})
  if (active) void checkWeeklyUpdate(context)
}

export async function deactivate(): Promise<void> {
  active = false
  await updating?.catch(() => {})
  const current = client
  client = undefined
  await current?.dispose()
}
