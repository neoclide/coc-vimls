import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface DocumentLike {
  lineCount: number
  getline?: (line: number) => string
  textDocument?: {
    lines: ReadonlyArray<string>
  }
}

/**
 * Check if the document or text snippet represents a Vim9 script.
 * A Vim9 script must have `vim9script` as the first command (only comments and empty lines can precede it).
 */
export function isVim9(doc?: DocumentLike | null, text?: string): boolean {
  if (text) {
    const lines = text.split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('"')) {
        continue
      }
      if (/^vim9script\b/.test(trimmed)) {
        return true
      }
      break
    }
  }
  if (doc) {
    const count = doc.lineCount
    for (let i = 0; i < count; i++) {
      const line = (doc.getline ? doc.getline(i) : doc.textDocument?.lines[i] ?? '').trim()
      if (!line || line.startsWith('#') || line.startsWith('"')) {
        continue
      }
      return /^vim9script\b/.test(line)
    }
  }
  return false
}

/**
 * Ensure `vim9script` header is present in the text snippet.
 */
export function ensureVim9script(text: string): string {
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('"')) {
      continue
    }
    if (/^vim9script\b/.test(trimmed)) {
      return text
    }
    break
  }
  return `vim9script\n${text}`
}

/**
 * Execute a Vim script file with system Vim executable in silent batch mode.
 */
export function runSystemVim(
  vimBin: string,
  scriptPath: string,
  timeout = 10000
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const cp = spawn(vimBin, ['-u', 'NONE', '-i', 'NONE', '-N', '-es', '-V1', '-S', scriptPath, '-c', 'qall!'])
    let output = ''
    let timer: NodeJS.Timeout | undefined

    if (timeout > 0) {
      timer = setTimeout(() => {
        cp.kill('SIGKILL')
        reject(new Error(`Execution timed out after ${timeout}ms`))
      }, timeout)
    }

    cp.stdout?.on('data', chunk => {
      output += chunk.toString()
    })
    cp.stderr?.on('data', chunk => {
      output += chunk.toString()
    })
    cp.on('error', err => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    cp.on('close', code => {
      if (timer) clearTimeout(timer)
      resolve({ code, output: output.replace(/\r\n/g, '\n').trim() })
    })
  })
}

export interface ExecuteOptions {
  isNvim: boolean
  vimCommand?: string
  timeout?: number
}

/**
 * Execute Vim script text.
 * For legacy Vim script, executes in the current editor session.
 * For Vim9 script in Neovim (or Vim without vim9script support), runs with system Vim.
 * For Vim9 script in Vim (with vim9script support), sources the script via a temp file.
 */
export async function executeVimScript(
  nvim: any,
  text: string,
  isVim9Script: boolean,
  options: ExecuteOptions
): Promise<string> {
  if (!isVim9Script) {
    const lines = text.split(/\r?\n/)
    const res = await nvim.call('execute', [lines])
    return typeof res === 'string' ? res.trim() : ''
  }

  const scriptContent = ensureVim9script(text)
  const canRunInVim = !options.isNvim && Boolean(await nvim.call('has', ['vim9script']).catch(() => 0))

  const tmpDir = await mkdtemp(join(tmpdir(), 'coc-vimls-'))
  const scriptPath = join(tmpDir, 'exec.vim')
  try {
    await writeFile(scriptPath, scriptContent, 'utf8')

    if (canRunInVim) {
      const escaped = await nvim.call('fnameescape', [scriptPath])
      const res = await nvim.call('execute', [`source ${escaped}`])
      return typeof res === 'string' ? res.trim() : ''
    }

    // In Neovim or Vim without vim9script support, use system vim
    const vimBin = options.vimCommand || 'vim'
    let res: { code: number | null; output: string }
    try {
      res = await runSystemVim(vimBin, scriptPath, options.timeout)
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new Error(`system vim executable "${vimBin}" not found. Please install Vim 9 or configure vimls.vimCommand.`)
      }
      throw err
    }

    if (res.code !== 0) {
      throw new Error(res.output || `Vim exited with code ${res.code}`)
    }
    return res.output
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}
