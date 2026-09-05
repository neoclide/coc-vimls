import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { commands, DocumentSymbol, LanguageClient, services, workspace } from 'coc.nvim'
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
  it('keeps the installed binary when a download fails checksum verification', async () => {
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
      checksum = '0'.repeat(64)
      await assert.rejects(installRelease(storage, { ...release, tag_name: 'v2.0.0' }), /SHA-256 mismatch/)
      assert.equal(await cachedServer(storage), binary)
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

})
