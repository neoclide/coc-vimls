import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { download, fetch, window } from 'coc.nvim'

export interface Release {
  tag_name: string
  assets: { name: string; browser_download_url: string }[]
}

export function assetName(platform = process.platform, arch = process.arch): string {
  const architectures: Partial<Record<NodeJS.Architecture, string>> = { x64: 'amd64', arm64: 'arm64', arm: 'armv7' }
  const architecture = architectures[arch]
  const os = platform === 'win32' ? 'windows' : platform
  if (!architecture || !['darwin', 'linux', 'windows', 'freebsd'].includes(os)) {
    throw new Error(`No vimls-go release binary for ${platform}/${arch}; configure vimls.command.`)
  }
  return `vimls-${os}-${architecture}${platform === 'win32' ? '.exe' : ''}`
}

export async function latestRelease(): Promise<Release> {
  const release = await fetch('https://api.github.com/repos/neoclide/vimls-go/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'coc-vimls' },
    timeout: 30000,
  }) as Release
  if (!release || typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) {
    throw new Error('Invalid vimls-go release response from GitHub')
  }
  return release
}

export async function cachedServer(storage: string): Promise<string | undefined> {
  try {
    const name = (await readFile(join(storage, 'current'), 'utf8')).trim()
    // Only accept our own direct child directories.
    if (!/^server-[a-zA-Z0-9]+$/.test(name)) return
    const binary = join(storage, name, process.platform === 'win32' ? 'vimls.exe' : 'vimls')
    await access(binary, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return binary
  } catch (error) {
    if (['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) return
    throw error
  }
}

export async function installedVersion(storage: string): Promise<string | undefined> {
  try {
    const name = (await readFile(join(storage, 'current'), 'utf8')).trim()
    if (!/^server-[a-zA-Z0-9]+$/.test(name)) return
    return (await readFile(join(storage, name, 'version'), 'utf8')).trim()
  } catch {
    return
  }
}

export async function installRelease(storage: string, release: Release): Promise<string> {
  const name = assetName()
  const asset = release.assets.find(asset => asset.name === name)
  const checksums = release.assets.find(asset => asset.name === 'checksums.txt')
  if (!asset || !checksums) throw new Error(`Release ${release.tag_name} is missing ${name} or checksums.txt`)
  const previous = await cachedServer(storage)
  await mkdir(storage, { recursive: true })
  const directory = await mkdtemp(join(storage, 'server-'))
  const binary = join(directory, process.platform === 'win32' ? 'vimls.exe' : 'vimls')
  try {
    const checksumText = await fetch(checksums.browser_download_url, { timeout: 30000 })
    const line = String(checksumText).split(/\r?\n/).find(line => line.trim().split(/\s+/)[1]?.replace(/^\*/, '') === name)
    const expected = line?.trim().split(/\s+/)[0]
    if (!expected || !/^[a-fA-F0-9]{64}$/.test(expected)) throw new Error(`Missing SHA-256 checksum for ${name}`)
    const downloaded = await download(asset.browser_download_url, { dest: directory, timeout: 120000 })
    const actual = createHash('sha256').update(await readFile(downloaded)).digest('hex')
    if (actual !== expected.toLowerCase()) throw new Error(`SHA-256 mismatch for ${name}`)
    await rename(downloaded, binary)
    await chmod(binary, 0o755)
    await writeFile(join(directory, 'version'), release.tag_name)
    // Publish only a complete installation before pruning older versions.
    const marker = join(directory, 'current')
    await writeFile(marker, basename(directory))
    await rename(marker, join(storage, 'current'))
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  // Retain the previous installation, which the client may still be running.
  // Cleanup failure must never roll back or delete the published installation.
  try {
    for (const entry of await readdir(storage, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^server-[a-zA-Z0-9]+$/.test(entry.name)) continue
      const candidate = join(storage, entry.name)
      if (candidate === directory || (previous && candidate === dirname(previous))) continue
      await rm(candidate, { recursive: true, force: true })
    }
  } catch (error) {
    void window.showWarningMessage(`vimls-go was installed, but old versions could not be removed: ${String(error)}`)
  }
  return binary
}

export async function ensureServer(storage: string, update = false): Promise<string> {
  const cached = await cachedServer(storage)
  if (cached && !update) return cached
  const release = await latestRelease()
  if (cached && await readFile(join(cached, '..', 'version'), 'utf8') === release.tag_name) return cached
  return installRelease(storage, release)
}

/** The installer retains at most one previous complete installation. */
export async function previousServer(storage: string): Promise<string | undefined> {
  // Identify the current installation without requiring its binary to work.
  let current: string
  try {
    current = (await readFile(join(storage, 'current'), 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!/^server-[a-zA-Z0-9]+$/.test(current)) return
  for (const entry of await readdir(storage, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^server-[a-zA-Z0-9]+$/.test(entry.name)) continue
    const binary = join(storage, entry.name, process.platform === 'win32' ? 'vimls.exe' : 'vimls')
    if (entry.name === current) continue
    try {
      await access(binary, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      await readFile(join(storage, entry.name, 'version'), 'utf8')
      return binary
    } catch { /* Incomplete installations are not rollback candidates. */ }
  }
}

export async function selectServer(storage: string, binary: string): Promise<void> {
  const directory = dirname(binary)
  if (dirname(directory) !== storage || !/^server-[a-zA-Z0-9]+$/.test(basename(directory))) {
    throw new Error('Invalid managed server path')
  }
  await access(binary, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
  const marker = join(directory, 'current')
  await writeFile(marker, basename(directory))
  await rename(marker, join(storage, 'current'))
}
