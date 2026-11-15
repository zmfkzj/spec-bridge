import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SPECBRIDGE_VERSION: string = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** JSON with sorted object keys, for content fingerprints and reproducibility hashes. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const o = v as Record<string, unknown>
  return '{' + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}'
}

export function fingerprint(v: unknown): string {
  return sha256(stableStringify(v)).slice(0, 16)
}

export function fileSha(path: string): string {
  return sha256(readFileSync(path))
}

export function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function rel(root: string, p: string): string {
  return relative(root, p).split(sep).join('/')
}

export function listFiles(dir: string, ext: string[]): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...listFiles(p, ext))
    else if (ext.some(e => name.endsWith(e))) out.push(p)
  }
  return out.sort()
}

export function gitInfo(dir: string): { revision: string | null; dirty: boolean; top: string | null } {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) return { revision: null, dirty: false, top: null }
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
  const st = spawnSync('git', ['status', '--porcelain', '--', '.'], { cwd: dir, encoding: 'utf8' })
  return { revision: r.stdout.trim(), dirty: st.stdout.trim().length > 0, top }
}

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): { code: number | null; stdout: string; stderr: string; error?: string } {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, encoding: 'utf8', timeout: opts.timeoutMs ?? 300_000, maxBuffer: 256 * 1024 * 1024 })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message }
}

export function toolVersion(cmd: string, args: string[]): string {
  try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim().split('\n')[0] } catch { return 'unavailable' }
}

export function packageVersion(name: string): string {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules', name, 'package.json'), 'utf8')).version
  } catch { return 'unavailable' }
}

export function lineOf(text: string, index: number): number {
  let n = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

export function uniq<T>(xs: T[]): T[] { return [...new Set(xs)] }
