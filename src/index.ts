import { CodeAction, CodeActionKind, CodeActionProvider, commands, ExtensionContext, LanguageClient, languages, Range, services, window, workspace } from 'coc.nvim'
import { cachedServer, ensureServer, installedVersion, latestRelease } from './server'
import { executeVimScript, isVim9 } from './execute'

let client: LanguageClient | undefined
let updating: Promise<void> | undefined
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

async function checkWeeklyUpdate(context: ExtensionContext): Promise<void> {
  if (workspace.getConfiguration('vimls').get<string>('command', '')) {
    return
  }
  const lastCheck = context.globalState.get<number>('last_update_check', 0)
  const now = Date.now()
  if (now - lastCheck < ONE_WEEK_MS) return
  await context.globalState.update('last_update_check', now)
  try {
    const release = await latestRelease()
    const currentVer = await installedVersion(context.storagePath)
    if (currentVer && currentVer !== release.tag_name) {
      const item = await window.showInformationMessage(
        `A new vimls-go release (${release.tag_name}) is available. Current version: ${currentVer}.`,
        'Update now'
      )
      if (item === 'Update now') {
        void commands.executeCommand('vimls.update')
      }
    }
  } catch {
    // Ignore network or GitHub API errors during background check
  }
}

export async function activate(context: ExtensionContext): Promise<void> {
  const config = workspace.getConfiguration('vimls')
  const serverOptions = { command: config.get<string>('command', '') || '', args: config.get<string[]>('args', []) }
  context.subscriptions.push(commands.registerCommand('vimls.update', () => {
    if (workspace.getConfiguration('vimls').get<string>('command', '')) {
      return window.showInformationMessage('vimls.command is configured; update that executable manually or clear vimls.command to use GitHub releases.')
    }
    updating ??= (async () => {
      const command = await window.withProgress({ title: 'Updating vimls-go' }, () => ensureServer(context.storagePath, true))
      if (client) {
        await client.stop()
        serverOptions.command = command
        await client.start()
      }
      await window.showInformationMessage('vimls-go is up to date.')
    })().finally(() => { updating = undefined })
    return updating
  }))

  context.subscriptions.push(commands.registerCommand('vimls.restart', async () => {
    if (!client) return
    try {
      if (client.isRunning()) {
        await client.restart()
      } else {
        await client.start()
      }
      window.showMessage('vimls-go server restarted')
    } catch (error) {
      void window.showErrorMessage(`Failed to restart vimls-go: ${String(error)}`)
    }
  }))

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

  serverOptions.command ||= await window.withProgress({ title: 'Installing vimls-go' }, () => ensureServer(context.storagePath))

  let runtimepath = workspace.env.runtimepath.split(',')

  context.subscriptions.push(commands.registerCommand('vimls.doctor', async () => {
    const channel = client ? client.outputChannel : window.createOutputChannel('vimls')
    channel.clear()
    channel.appendLine('=== vimls-go Doctor ===')
    channel.appendLine(`Status: ${client?.isRunning() ? 'running' : 'stopped'}`)
    const customCmd = workspace.getConfiguration('vimls').get<string>('command', '')
    channel.appendLine(`Custom Command: ${customCmd ? customCmd : '(none, using managed release)'}`)
    const binary = customCmd || (await cachedServer(context.storagePath)) || 'not found'
    channel.appendLine(`Binary: ${binary}`)
    const version = await installedVersion(context.storagePath)
    channel.appendLine(`Installed Version: ${version || (customCmd ? 'custom' : 'none')}`)
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

  const current = new LanguageClient('vimls', 'vimls-go', serverOptions, {
    documentSelector: [{ language: 'vim', scheme: 'file' }, { language: 'vim', scheme: 'untitled' }],
    initializationOptions: () => ({
      runtimepath,
      configFiles: workspace.getConfiguration('vim').get<string[]>('configFiles', []),
    }),
    synchronize: { configurationSection: 'vim' },
    outputChannelName: 'vimls',
  })
  client = current
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
  context.subscriptions.push(services.registerLanguageClient(current))
  void checkWeeklyUpdate(context)
}

export async function deactivate(): Promise<void> {
  await updating?.catch(() => {})
  const current = client
  client = undefined
  await current?.dispose()
}
