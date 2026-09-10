import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { switchServer } from '../src/lifecycle.ts'

describe('managed server switching', () => {
  it('selects the new installation before starting it', async () => {
    const options = { command: 'old' }
    const events: string[] = []
    await switchServer({
      stop: async () => { events.push('stop') },
      start: async () => { events.push(`start ${options.command}`) },
    }, options, 'new', async command => { events.push(`select ${command}`) })
    assert.deepEqual(events, ['stop', 'select new', 'start new'])
    assert.equal(options.command, 'new')
  })

  it('restores the cache and restarts the old binary when initialization fails', async () => {
    const options = { command: 'old' }
    const events: string[] = []
    await assert.rejects(switchServer({
      stop: async () => { events.push('stop') },
      start: async () => {
        events.push(`start ${options.command}`)
        if (options.command === 'new') throw new Error('bad executable')
      },
    }, options, 'new', async command => { events.push(`select ${command}`) }), /bad executable.*Previous server restored/)
    assert.equal(options.command, 'old')
    assert.deepEqual(events, ['stop', 'select new', 'start new', 'stop', 'select old', 'start old'])
  })

  it('reports both errors if recovery also fails', async () => {
    const options = { command: 'old' }
    await assert.rejects(switchServer({
      stop: async () => {},
      start: async () => { throw new Error(`broken ${options.command}`) },
    }, options, 'new', async () => {}), /broken new.*Recovery failed.*broken old/)
  })

  it('does not attempt to start an absent previous installation', async () => {
    let attempts = 0
    await assert.rejects(switchServer({
      stop: async () => {},
      start: async () => { attempts++; throw new Error('first start failed') },
    }, { command: '' }, 'new', async () => {}), /first start failed/)
    assert.equal(attempts, 1)
  })
})
