import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, describe, it, TestContext } from 'node:test'
import { commands, ExtensionContext, LanguageClient, services, window, workspace } from 'coc.nvim'
import { activate, deactivate } from '../src/index.ts'
import { cachedServer, previousServer, selectServer } from '../src/server.ts'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

async function fixture(t: TestContext) {
  const storage = await mkdtemp(join(tmpdir(), 'coc-vimls-operations-'))
  const binary = process.platform === 'win32' ? 'vimls.exe' : 'vimls'
  const old = join(storage, 'server-old', binary)
  const next = join(storage, 'server-next', binary)
  for (const [name, command] of [['old', old], ['next', next]]) {
    await mkdir(join(storage, `server-${name}`))
    await writeFile(command, 'fixture', { mode: 0o755 })
    await writeFile(join(storage, `server-${name}`, 'version'), name)
  }
  await selectServer(storage, old)
  const handlers = new Map<string, () => Promise<void>>()
  const events: string[] = []
  const subscriptions: { dispose(): any }[] = []
  const config = workspace.getConfiguration('vimls')
  const originalCommand = config.get<string>('command')
  const originalCheck = config.get<boolean>('checkForUpdates')
  await config.update('command', '', true)
  await config.update('checkForUpdates', false, true)
  t.mock.method(commands, 'registerCommand', (id: string, handler: () => Promise<void>) => {
    handlers.set(id, handler)
    return { dispose() {} }
  })
  t.mock.method(window, 'showErrorMessage', async () => undefined)
  t.mock.method(window, 'showInformationMessage', async () => undefined)
  t.mock.method(window, 'showMessage', () => {})
  t.mock.method(services, 'registerLanguageClient', () => ({ dispose() {} }))
  t.mock.method(LanguageClient.prototype, 'dispose', async () => { events.push('dispose') })
  const state = {
    events, storage, old, next,
    install: async () => {},
    start: async (_attempt: number) => {},
    stop: async () => {},
    update: async () => {},
    run: (id: string) => handlers.get(`vimls.${id}`)!(),
    activate: () => activate({
      storagePath: storage, subscriptions,
      globalState: { get: () => Date.now(), update: async () => {} },
    } as unknown as ExtensionContext),
  }
  let attempts = 0
  t.mock.method(LanguageClient.prototype, 'start', async () => {
    events.push(`start ${++attempts}`)
    await state.start(attempts)
  })
  t.mock.method(LanguageClient.prototype, 'stop', async () => {
    events.push('stop')
    await state.stop()
  })
  t.mock.method(window, 'withProgress', async ({ title }: { title: string }) => {
    if (title === 'Installing vimls-go') {
      events.push('install')
      await state.install()
      return old
    }
    assert.equal(title, 'Updating vimls-go')
    events.push('update')
    await state.update()
    // Like ensureServer(), publish the completed installation before switching.
    await selectServer(storage, next)
    return next
  })
  t.after(async () => {
    await deactivate()
    for (const subscription of subscriptions) await subscription.dispose()
    await config.update('command', originalCommand, true)
    await config.update('checkForUpdates', originalCheck, true)
    await rm(storage, { recursive: true, force: true })
  })
  return state
}

describe('startup and managed operations', { timeout: 15000 }, () => {
  before(async () => { await deactivate() })

  for (const phase of ['install', 'start'] as const) {
    for (const command of ['update', 'rollback', 'restart']) {
      it(`waits for first ${phase} before ${command}`, async t => {
        const f = await fixture(t)
        const gate = deferred()
        const entered = deferred()
        f[phase] = async () => { entered.resolve(); await gate.promise }
        const activation = f.activate()
        await entered.promise
        const before = [...f.events]
        let settled = false
        const operation = f.run(command)
        const result = operation.then(() => { settled = true }, error => { settled = true; return error })
        try {
          await tick()
          assert.equal(settled, false, 'manual command must wait for startup')
          assert.deepEqual(f.events, before, 'no download or switch may race startup')
        } finally {
          gate.resolve()
          await activation
          await result
        }
        await operation
        assert.deepEqual(f.events, ['install', 'start 1', ...(command === 'update' ? ['update'] : []), 'stop', 'start 2'])
        assert.equal(await cachedServer(f.storage), command === 'restart' ? f.old : f.next)
      })
    }
  }

  it('keeps commands mutually exclusive after they wait for startup', async t => {
    const f = await fixture(t)
    const startup = deferred()
    const entered = deferred()
    const download = deferred()
    const updating = deferred()
    f.start = async attempt => {
      if (attempt === 1) { entered.resolve(); await startup.promise }
    }
    f.update = async () => { updating.resolve(); await download.promise }
    const activation = f.activate()
    await entered.promise
    const update = f.run('update')
    void update.catch(() => {})
    const rollback = assert.rejects(f.run('rollback'), /Another vimls operation is in progress/)
    const restart = assert.rejects(f.run('restart'), /Another vimls operation is in progress/)
    try {
      startup.resolve()
      await activation
      await Promise.race([updating.promise, update])
      await Promise.all([rollback, restart])
      // Finishing activation must not release the newer update's lock.
      await assert.rejects(f.run('update'), /Another vimls operation is in progress/)
      assert.deepEqual(f.events, ['install', 'start 1', 'update'])
    } finally {
      startup.resolve()
      download.resolve()
      await Promise.allSettled([activation, update, rollback, restart])
    }
    await f.run('rollback')
    await f.run('restart')
    assert.equal(await cachedServer(f.storage), f.old)
  })

  for (const phase of ['install', 'start'] as const) {
    it(`allows an update to recover after first ${phase} fails`, async t => {
      const f = await fixture(t)
      const gate = deferred()
      const entered = deferred()
      let first = true
      f[phase] = async () => {
        if (first) { first = false; entered.resolve(); await gate.promise }
      }
      const activation = f.activate()
      await entered.promise
      const operation = f.run('update')
      const result = operation.catch(() => {})
      gate.reject(new Error('fixture startup failed'))
      await activation
      await result
      await operation
      assert.equal(await cachedServer(f.storage), f.next)
      await f.run('restart')
    })
  }

  it('holds the operation lock through failed update recovery and cleanup', async t => {
    const f = await fixture(t)
    await f.activate()
    const restoring = deferred()
    const recovery = deferred()
    f.start = async attempt => {
      if (attempt === 2) throw new Error('bad executable')
      if (attempt === 3) { restoring.resolve(); await recovery.promise }
    }
    const update = assert.rejects(f.run('update'), /bad executable.*Previous server restored/)
    try {
      await Promise.race([restoring.promise, update])
      for (const command of ['update', 'rollback', 'restart']) {
        await assert.rejects(f.run(command), /Another vimls operation is in progress/)
      }
    } finally {
      recovery.resolve()
      await update
    }
    assert.equal(await cachedServer(f.storage), f.old)
    assert.equal(await previousServer(f.storage), undefined, 'failed installation was removed')
    await f.run('restart')
  })

  it('does not run waiting commands after deactivation starts', async t => {
    const f = await fixture(t)
    const gate = deferred()
    const entered = deferred()
    f.start = async () => { entered.resolve(); await gate.promise }
    const activation = f.activate()
    await entered.promise
    const operation = assert.rejects(f.run('update'), /no longer active/)
    const stopping = deactivate()
    gate.resolve()
    await Promise.all([activation, operation, stopping])
    assert.deepEqual(f.events, ['install', 'start 1', 'dispose'])
  })
})
