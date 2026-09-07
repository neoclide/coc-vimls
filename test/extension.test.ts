import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { CodeAction, CodeActionKind, commands, Diagnostic, diagnosticManager, DocumentSymbol, LanguageClient, Range, services, workspace } from 'coc.nvim'
import { deactivate } from '../src/index.ts'
import { assetName, cachedServer, installRelease } from '../src/server.ts'

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for vimls-go')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('coc-vimls', () => {
  let client: LanguageClient
  let directory: string
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'coc-vimls-'))
    await workspace.nvim.command('enew!')
    await workspace.nvim.command('setfiletype vim')
    await waitFor(() => services.getService('vimls')?.client?.isRunning() === true)
    client = services.getService('vimls').client!
  })
  after(async () => {
    await deactivate()
    assert.equal(client?.isRunning(), false)
    await workspace.nvim.command('bwipeout!')
    await rm(directory, { recursive: true, force: true })
  })

  it('analyzes a Vim buffer through the real server', async () => {
    const document = await workspace.document
    await document.buffer.setLines(['function! HelloVimls()', '  return 42', 'endfunction'], { start: 0, end: -1, strictIndexing: false })
    await document.synchronize()
    const symbols = await client.sendRequest<DocumentSymbol[]>('textDocument/documentSymbol', {
      textDocument: { uri: document.uri },
    })
    assert.ok(symbols.some(symbol => symbol.name.includes('HelloVimls')))
    assert.equal(await workspace.nvim.eval('&filetype'), 'vim')
  })

  it('passes server settings and initialization options', () => {
    assert.equal(client.clientOptions.synchronize?.configurationSection, 'vim')
    const options = client.clientOptions.initializationOptions()
    assert.ok(Array.isArray(options.runtimepath))
    assert.ok(options.runtimepath.length > 0)
    assert.deepEqual(options.configFiles, [])
  })

  it('toggles protocol tracing through vimls.trace.server', async () => {
    const channel = client.outputChannel
    const appendLine = channel.appendLine.bind(channel)
    const lines: string[] = []
    channel.appendLine = value => {
      lines.push(value)
      appendLine(value)
    }
    const config = workspace.getConfiguration('vimls')
    const document = await workspace.document
    const request = () => client.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri: document.uri },
    })
    try {
      for (const level of ['messages', 'verbose']) {
        await config.update('trace.server', level, true)
        lines.length = 0
        await request()
        assert.ok(lines.some(line => line.includes('textDocument/documentSymbol')))
      }
      await config.update('trace.server', 'off', true)
      lines.length = 0
      await request()
      assert.equal(lines.some(line => line.includes('textDocument/documentSymbol')), false)
    } finally {
      await config.update('trace.server', 'off', true)
      channel.appendLine = appendLine
    }
  })

  it('sends full runtimepath updates for additions and removals', async () => {
    const root = join(directory, 'runtime with spaces')
    await mkdir(root)
    const original = await workspace.nvim.eval('&runtimepath') as string
    const requests: string[][] = []
    const sendRequest = client.sendRequest.bind(client)
    client.sendRequest = (async (method: string, params: any) => {
      const result = await sendRequest(method, params)
      if (method === 'vimls/didChangeRuntimepath') requests.push(params.runtimepath)
      return result
    }) as typeof client.sendRequest
    try {
      await workspace.nvim.command(`let &runtimepath = '${`${original},${root}`.replaceAll("'", "''")}'`)
      await waitFor(() => requests.some(paths => paths.some(path => resolve(path) === root)))
      const count = requests.length
      await workspace.nvim.command(`let &runtimepath = '${original.replaceAll("'", "''")}'`)
      await waitFor(() => requests.length > count && !requests.at(-1)!.some(path => resolve(path) === root))
      assert.deepEqual(Array.from(requests.at(-1)!), original.split(','))
    } finally {
      await workspace.nvim.command(`let &runtimepath = '${original.replaceAll("'", "''")}'`)
      client.sendRequest = sendRequest
    }
  })
  it('retains one previous version and preserves both versions on failed downloads', async () => {
    const body = Buffer.from('fixture server binary')
    let checksum = createHash('sha256').update(body).digest('hex')
    const http = createServer((request, response) => {
      if (request.url === '/checksums.txt') {
        response.setHeader('Content-Type', 'text/plain')
        response.end(`${checksum}  ${assetName()}\n`)
      } else {
        response.end(body)
      }
    })
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    try {
      const address = http.address() as { port: number }
      const base = `http://127.0.0.1:${address.port}`
      const storage = join(directory, 'downloads')
      const release = { tag_name: 'v1.0.0', assets: [
        { name: assetName(), browser_download_url: `${base}/${assetName()}` },
        { name: 'checksums.txt', browser_download_url: `${base}/checksums.txt` },
      ] }
      const binary = await installRelease(storage, release)
      assert.equal(await cachedServer(storage), binary)
      await mkdir(join(storage, 'unrelated'))
      const second = await installRelease(storage, { ...release, tag_name: 'v2.0.0' })
      assert.deepEqual((await readdir(storage)).sort(), [basename(dirname(binary)), basename(dirname(second)), 'current', 'unrelated'].sort())
      const third = await installRelease(storage, { ...release, tag_name: 'v3.0.0' })
      const retained = [basename(dirname(second)), basename(dirname(third)), 'current', 'unrelated'].sort()
      assert.deepEqual((await readdir(storage)).sort(), retained)
      assert.equal(await cachedServer(storage), third)
      checksum = '0'.repeat(64)
      await assert.rejects(installRelease(storage, { ...release, tag_name: 'v4.0.0' }), /SHA-256 mismatch/)
      assert.equal(await cachedServer(storage), third)
      assert.deepEqual((await readdir(storage)).sort(), retained)
      assert.equal(assetName('win32', 'x64'), 'vimls-windows-amd64.exe')
      assert.throws(() => assetName('linux', 'ia32'), /No vimls-go release binary/)
    } finally {
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()))
    }
  })

  it('updates from GitHub releases and restarts the service', async () => {
    assert.equal(commands.has('vimls.update'), true)
    await workspace.getConfiguration('vimls').update('command', '', true)
    await commands.executeCommand('vimls.update')
    assert.equal(client.isRunning(), true)
    const document = await workspace.document
    const symbols = await client.sendRequest<DocumentSymbol[]>('textDocument/documentSymbol', {
      textDocument: { uri: document.uri },
    })
    assert.ok(symbols.some(symbol => symbol.name.includes('HelloVimls')))
  })

  it('supports restart, openOutput, and doctor commands', async () => {
    assert.equal(commands.has('vimls.restart'), true)
    assert.equal(commands.has('vimls.openOutput'), true)
    assert.equal(commands.has('vimls.doctor'), true)
    assert.equal(commands.has('vimls.executeSelected'), true)

    await commands.executeCommand('vimls.openOutput')
    await commands.executeCommand('vimls.doctor')
    await commands.executeCommand('vimls.restart')
    await waitFor(() => client.isRunning() === true)
    assert.equal(client.isRunning(), true)
  })

  it('provides codeAction for nonempty range and executes selected Vim script', async () => {
    const document = await workspace.document
    await document.buffer.setLines(['let g:coc_vimls_tested = 100'], { start: 0, end: -1, strictIndexing: false })
    await document.synchronize()

    const range = Range.create(0, 0, 0, 28)
    await commands.executeCommand('vimls.executeSelected', document.uri, range)
    assert.equal(await workspace.nvim.getVar('coc_vimls_tested'), 100)
  })

  it('executes selected Vim9 script using system vim in Neovim', async () => {
    const document = await workspace.document
    await document.buffer.setLines(['vim9script', 'var test_num = 123 + 456', 'echo test_num'], { start: 0, end: -1, strictIndexing: false })
    await document.synchronize()

    const range = Range.create(1, 0, 2, 13)
    const res = await commands.executeCommand('vimls.executeSelected', document.uri, range)
    assert.equal(res, '579')
  })

  it('offers the nearest diagnostic quickfix and preserves disabled codes', async t => {
    const document = await workspace.document
    await document.buffer.setLines(['" 中文 ' + 'x'.repeat(60), '" another line'], { start: 0, end: -1, strictIndexing: false })
    await document.synchronize()
    const diagnostic = (code: string, range: Range): Diagnostic => ({ code, range, message: code, source: 'vimls' })
    const left = diagnostic('left', Range.create(0, 5, 0, 10))
    const right = diagnostic('right', Range.create(0, 25, 0, 30))
    t.mock.method(diagnosticManager, 'getDiagnosticsInRange', () => [
      left, right, diagnostic('other-line', Range.create(1, 0, 1, 20)),
      { ...diagnostic('other-provider', Range.create(0, 22, 0, 24)), source: 'other' },
    ])
    const config = workspace.getConfiguration('vim')
    const original = config.inspect<string[]>('diagnostic.disabled')?.globalValue
    try {
      await config.update('diagnostic.disabled', ['existing'], true)
      // Vim cursor columns are bytes; the provider must compare UTF-16 columns.
      await workspace.nvim.call('cursor', [1, Buffer.byteLength(document.getline(0).slice(0, 23)) + 1])
      const actions = await workspace.nvim.call('CocAction', ['codeActions', 'line', [CodeActionKind.QuickFix]]) as CodeAction[]
      const fixes = actions.filter(action => action.command?.command === 'vimls.disableDiagnostic')
      assert.equal(fixes.length, 1)
      assert.equal(fixes[0].title, 'Disable diagnostic right')
      assert.equal(fixes[0].diagnostics?.[0].code, 'right')
      assert.deepEqual(workspace.getConfiguration('vim').get('diagnostic.disabled'), ['existing'])
      // Read the configuration when executing, including changes made since the menu opened.
      await config.update('diagnostic.disabled', ['existing', 'added-later'], true)
      await workspace.nvim.call('CocAction', ['doCodeAction', fixes[0]])
      await workspace.nvim.call('CocAction', ['doCodeAction', fixes[0]])
      assert.deepEqual(workspace.getConfiguration('vim').get('diagnostic.disabled'), ['existing', 'added-later', 'right'])
    } finally {
      await config.update('diagnostic.disabled', original, true)
    }
  })

  it('prefers a containing diagnostic over a closer start and excludes other lines', async t => {
    const document = await workspace.document
    await document.buffer.setLines(['" ' + 'x'.repeat(60), '" empty'], { start: 0, end: -1, strictIndexing: false })
    await document.synchronize()
    t.mock.method(diagnosticManager, 'getDiagnosticsInRange', () => [
      { code: 'near-start', source: 'vimls', message: '', range: Range.create(0, 26, 0, 28) },
      { code: 'containing', source: 'vimls', message: '', range: Range.create(0, 2, 0, 25) },
    ])
    await workspace.nvim.call('cursor', [1, 24])
    const getFixes = async () => {
      const actions = await workspace.nvim.call('CocAction', ['codeActions', 'cursor', [CodeActionKind.QuickFix]]) as CodeAction[]
      return actions.filter(action => action.command?.command === 'vimls.disableDiagnostic')
    }
    assert.equal((await getFixes())[0]?.title, 'Disable diagnostic containing')
    await workspace.nvim.call('cursor', [2, 1])
    assert.equal((await getFixes()).length, 0)
  })

  it('ignores diagnostics without codes and multiline ranges ending before the current line', async t => {
    const document = await workspace.document
    await document.buffer.setLines(['" first', '" second'], { start: 0, end: -1, strictIndexing: false })
    await document.synchronize()
    t.mock.method(diagnosticManager, 'getDiagnosticsInRange', () => [
      { source: 'vimls', message: 'no code', range: Range.create(1, 0, 1, 8) },
      { code: 'previous-line', source: 'vimls', message: '', range: Range.create(0, 0, 1, 0) },
    ])
    await workspace.nvim.call('cursor', [2, 3])
    const actions = await workspace.nvim.call('CocAction', ['codeActions', 'line', [CodeActionKind.QuickFix]]) as CodeAction[]
    assert.equal(actions.filter(action => action.command?.command === 'vimls.disableDiagnostic').length, 0)
  })

  it('disables a real pull diagnostic hint through coc-fix-current', async () => {
    await workspace.nvim.command('enew!')
    await workspace.nvim.command('setfiletype vim')
    const document = await workspace.document
    const config = workspace.getConfiguration('vim')
    const original = config.inspect<string[]>('diagnostic.disabled')?.globalValue
    const code = 'vimls/unused-variable'
    try {
      await config.update('diagnostic.disabled', [], true)
      await document.buffer.setLines(['vim9script', 'var UnusedQuickfix = 1'], { start: 0, end: -1, strictIndexing: false })
      await document.synchronize()
      await workspace.nvim.call('cursor', [2, 8])
      const diagnostics = () => diagnosticManager.getDiagnosticsInRange(document.textDocument, Range.create(0, 0, 2, 0))
      await waitFor(() => diagnostics().some(diagnostic => diagnostic.code === code))
      assert.equal(diagnostics().find(diagnostic => diagnostic.code === code)?.severity, 4)
      const actions = await workspace.nvim.call('CocAction', ['quickfixes', 'currline']) as CodeAction[]
      assert.ok(actions.some(action => action.title === `Disable diagnostic ${code}`))
      // This is the action invoked by <Plug>(coc-fix-current).
      await workspace.nvim.call('CocAction', ['doQuickfix'])
      assert.deepEqual(workspace.getConfiguration('vim').get('diagnostic.disabled'), [code])
      await waitFor(() => !diagnostics().some(diagnostic => diagnostic.code === code))
    } finally {
      await config.update('diagnostic.disabled', original, true)
    }
  })
})
