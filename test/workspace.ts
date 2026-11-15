// Shared helpers for scenario/benchmark runs: workspaces are materialised under <repo>/.work/
// (git-ignored, inside the repository so TypeSpec can resolve its libraries from node_modules).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, run } from '../src/util.ts'

export const WORK = join(REPO_ROOT, '.work')
const SKIP = new Set(['.specbridge', 'node_modules', '.git'])

export function copyTree(from: string, to: string) {
  cpSync(from, to, { recursive: true, filter: s => !SKIP.has(s.split(/[\\/]/).pop()!) || s === from })
}

export function overlayFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string, rel: string) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p, join(rel, n)) : out.push(join(rel, n)) } }
  walk(dir, '')
  return out.sort()
}

/** Copy base into a fresh git repo, commit it as the baseline, then apply the overlay on top (uncommitted). */
export function prepareWorkspace(name: string, base: string, overlay: string | null, opts: { git?: boolean; remove?: string[] } = {}): string {
  const ws = join(WORK, name)
  rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  copyTree(base, ws)
  if (opts.git !== false) {
    const g = (...a: string[]) => { const r = run('git', a, { cwd: ws }); if (r.code !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`) }
    g('init', '-q', '-b', 'main')
    g('add', '-A')
    g('-c', 'user.name=specbridge-bench', '-c', 'user.email=bench@specbridge.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline')
  }
  if (overlay && existsSync(overlay)) copyTree(overlay, ws)
  for (const r of opts.remove ?? []) rmSync(join(ws, r), { recursive: true, force: true })
  return ws
}

export function runCli(ws: string, args: string[], env: Record<string, string> = {}): { exitCode: number | null; report: any; stderr: string } {
  const out = join(ws, '.specbridge-report.json')
  rmSync(out, { force: true })
  const r = run(process.execPath, [join(REPO_ROOT, 'bin/specbridge.mjs'), ...args, '-w', ws, '--format', 'json', '--out', out], { env: { ...process.env, ...env } })
  const report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
  return { exitCode: r.code, report, stderr: r.stderr }
}

export function scenario(name: string) {
  const dir = join(REPO_ROOT, 'examples/scenarios', name)
  const spec = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'))
  const ws = prepareWorkspace(`scenarios/${name}`, join(REPO_ROOT, 'examples/jobs-platform'), join(dir, 'overlay'))
  const t = performance.now()
  const res = runCli(ws, spec.args)
  return { ...res, ws, spec, ms: Math.round(performance.now() - t) }
}
