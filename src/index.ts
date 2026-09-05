import { commands, ExtensionContext, LanguageClient, services, window, workspace } from 'coc.nvim'
import { ensureServer } from './server'

let client: LanguageClient | undefined
let updating: Promise<void> | undefined

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
  serverOptions.command ||= await window.withProgress({ title: 'Installing vimls-go' }, () => ensureServer(context.storagePath))

  let runtimepath = workspace.env.runtimepath.split(',')
  const current = new LanguageClient('vimls', 'vimls-go', serverOptions, {
    documentSelector: [{ language: 'vim', scheme: 'file' }, { language: 'vim', scheme: 'untitled' }],
    initializationOptions: () => ({
      runtimepath,
      configFiles: workspace.getConfiguration('vim').get<string[]>('configFiles', []),
    }),
    synchronize: { configurationSection: 'vim' },
    outputChannelName: 'vimls-go',
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
}

export async function deactivate(): Promise<void> {
  await updating?.catch(() => {})
  const current = client
  client = undefined
  await current?.dispose()
}
