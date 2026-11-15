// Materialise comparison workspaces WITHOUT touching the user's working tree:
// - git baselines via `git archive <ref>` (no checkout/reset/stash)
// - "after change" views by copying the workspace and applying the OpenSpec change with the
//   official `openspec archive <change> --yes` on the COPY (OpenSpec stays the delta authority).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { IR_DIR } from '../ir/build.ts'
import { REPO_ROOT, run } from '../util.ts'

export function materializeGitBaseline(workspace: string, ref: string): { dir: string; revision: string } {
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd: workspace })
  if (top.code !== 0) throw new Error(`workspace is not inside a git repository: ${top.stderr.trim()}`)
  const rev = run('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: workspace })
  if (rev.code !== 0) throw new Error(`git ref '${ref}' not found: ${rev.stderr.trim()}`)
  const revision = rev.stdout.trim()
  const prefix = relative(top.stdout.trim(), workspace).split('\\').join('/')
  const cache = join(workspace, IR_DIR, 'cache', `baseline-${revision.slice(0, 12)}`)
  rmSync(cache, { recursive: true, force: true })
  mkdirSync(cache, { recursive: true })
  const tar = join(cache, 'baseline.tar')
  const a = run('git', ['archive', '--format=tar', '-o', tar, revision, '--', prefix || '.'], { cwd: top.stdout.trim() })
  if (a.code !== 0) throw new Error(`git archive failed: ${a.stderr}`)
  const x = run('tar', ['-xf', tar, '-C', cache])
  if (x.code !== 0) throw new Error(`tar failed: ${x.stderr}`)
  rmSync(tar)
  return { dir: prefix ? join(cache, prefix) : cache, revision }
}

const SKIP = new Set(['node_modules', IR_DIR, '.git'])

export function materializeChangeApplied(workspace: string, change: string): { dir: string; output: string } {
  const dir = join(workspace, IR_DIR, 'cache', `change-${change}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  // copy top-level entries one by one (the cache lives inside the workspace, so cpSync(workspace) is refused)
  for (const name of readdirSync(workspace)) {
    if (SKIP.has(name)) continue
    cpSync(join(workspace, name), join(dir, name), { recursive: true, filter: (s) => !SKIP.has(s.split(/[\\/]/).pop()!) })
  }
  if (!existsSync(join(dir, 'openspec/changes', change))) throw new Error(`OpenSpec change '${change}' not found`)
  const r = run(process.execPath, [join(REPO_ROOT, 'node_modules/@fission-ai/openspec/bin/openspec.js'), 'archive', change, '--yes'], { cwd: dir, env: { ...process.env, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', NO_COLOR: '1' } })
  if (r.code !== 0) throw new Error(`openspec archive ${change} (on a copy) failed: ${(r.stderr || r.stdout).slice(0, 800)}`)
  return { dir, output: r.stdout }
}
