import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isVim9, ensureVim9script, runSystemVim, executeVimScript } from '../src/execute.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Vim execution utilities', () => {
  describe('isVim9', () => {
    it('detects vim9script at line 0', () => {
      const doc = {
        lineCount: 3,
        getline(n: number) {
          return ['vim9script', 'var a = 1', 'echo a'][n]
        }
      }
      assert.equal(isVim9(doc, 'echo a'), true)
    })

    it('detects vim9script preceded by comments and empty lines', () => {
      const doc = {
        lineCount: 5,
        getline(n: number) {
          return ['" Comment 1', '# Comment 2', '', '  vim9script nocache', 'var a = 1'][n]
        }
      }
      assert.equal(isVim9(doc, 'var a = 1'), true)
    })

    it('returns false for legacy vim script', () => {
      const doc = {
        lineCount: 3,
        getline(n: number) {
          return ['" Comment', 'let g:test = 1', 'echo g:test'][n]
        }
      }
      assert.equal(isVim9(doc, 'let g:test = 1'), false)
    })

    it('returns true if selected text itself contains vim9script', () => {
      const text = 'vim9script\nvar a = 10\necho a'
      assert.equal(isVim9(null, text), true)
    })

    it('returns false for empty doc and text', () => {
      assert.equal(isVim9(null, ''), false)
      assert.equal(isVim9({ lineCount: 0 }, ''), false)
    })
  })

  describe('ensureVim9script', () => {
    it('prepends vim9script if absent', () => {
      const text = 'var a = 1\necho a'
      assert.equal(ensureVim9script(text), 'vim9script\nvar a = 1\necho a')
    })

    it('does not duplicate vim9script if already present', () => {
      const text = 'vim9script\nvar a = 1\necho a'
      assert.equal(ensureVim9script(text), text)
    })

    it('does not duplicate vim9script if preceded by comments', () => {
      const text = '# header\nvim9script\nvar a = 1'
      assert.equal(ensureVim9script(text), text)
    })
  })

  describe('runSystemVim', () => {
    it('executes vim9 script and returns output', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'coc-vimls-test-'))
      const scriptPath = join(tmpDir, 'test.vim')
      try {
        await writeFile(scriptPath, 'vim9script\nvar a = [1, 2, 3]\necho a\n', 'utf8')
        const { code, output } = await runSystemVim('vim', scriptPath)
        assert.equal(code, 0)
        assert.equal(output, '[1, 2, 3]')
      } finally {
        await rm(tmpDir, { recursive: true, force: true })
      }
    })

    it('captures errors with non-zero exit code', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'coc-vimls-test-'))
      const scriptPath = join(tmpDir, 'test_err.vim')
      try {
        await writeFile(scriptPath, 'vim9script\necho undefined_variable_xyz\n', 'utf8')
        const { code, output } = await runSystemVim('vim', scriptPath)
        assert.notEqual(code, 0)
        assert.ok(output.includes('E121') || output.includes('Undefined variable'))
      } finally {
        await rm(tmpDir, { recursive: true, force: true })
      }
    })
  })

  describe('executeVimScript', () => {
    it('executes legacy vim script directly via nvim.call', async () => {
      const calls: any[] = []
      const fakeNvim = {
        call: async (method: string, args: any[]) => {
          calls.push({ method, args })
          return 'legacy result'
        }
      }
      const res = await executeVimScript(fakeNvim, 'let g:x = 1', false, { isNvim: true })
      assert.equal(res, 'legacy result')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].method, 'execute')
      assert.equal(calls[0].args[0][0], 'let g:x = 1')
    })

    it('executes vim9script via system vim when isNvim is true', async () => {
      const calls: any[] = []
      const fakeNvim = {
        call: async (method: string, args: any[]) => {
          calls.push({ method, args })
          return ''
        }
      }
      const res = await executeVimScript(fakeNvim, 'var msg = "hello vim9"\necho msg', true, {
        isNvim: true,
        vimCommand: 'vim',
      })
      assert.equal(res, 'hello vim9')
      assert.equal(calls.length, 0) // Did not call nvim.call because nvim does not support vim9
    })
  })
})
