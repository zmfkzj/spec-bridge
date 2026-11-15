import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import YAML from 'yaml'

export interface SpecBridgeConfig {
  workspace: string
  openspec: { root: string } | null       // directory containing openspec/
  likec4: { root: string } | null         // LikeC4 workspace directory
  typespec: { main: string } | null       // TypeSpec entry file
  alloy: { models: string[] } | null      // explicit .als models
  mappings: string                        // approved mappings file (source-controlled)
  policies: {
    /** Requirement ids (glob with *) that MUST be backed by an executed formal assertion. */
    formalVerificationRequired: string[]
    /** Default architecture policy: an operation has exactly one providing component. */
    singleProvider: boolean
    impactMaxDepth: number
    impactMaxNodes: number
  }
  alloyProjections: AlloyProjection[]
}

/** Deterministic projection of LikeC4 structure into an explicit Alloy model (Architecture-Invariant check). */
export interface AlloyProjection {
  id: string
  model: string                // .als model (workspace-relative)
  sig: string                  // Alloy sig that represents architecture elements
  relation: string             // Alloy field (sig -> sig) that receives LikeC4 relations
  elementKinds: string[]       // LikeC4 element kinds to project
  atoms?: Record<string, string> // existing one-sigs of the model -> LikeC4 FQN
  assertions: string[]
}

export const CONFIG_FILE = 'specbridge.yaml'

export function loadConfig(workspace: string): SpecBridgeConfig {
  const ws = resolve(workspace)
  const file = join(ws, CONFIG_FILE)
  const raw: any = existsSync(file) ? YAML.parse(readFileSync(file, 'utf8')) ?? {} : {}
  const pick = <T>(key: string, def: T | null, detect: () => boolean): T | null => {
    if (raw[key] === null || raw[key] === false) return null
    if (raw[key] !== undefined) return raw[key]
    return detect() ? def : null
  }
  return {
    workspace: ws,
    openspec: pick('openspec', { root: '.' }, () => existsSync(join(ws, 'openspec'))),
    likec4: pick('likec4', { root: 'architecture' }, () => existsSync(join(ws, 'architecture'))),
    typespec: pick('typespec', { main: 'api/main.tsp' }, () => existsSync(join(ws, 'api/main.tsp'))),
    alloy: pick('alloy', { models: [] as string[] }, () => existsSync(join(ws, 'formal'))),
    mappings: raw.mappings ?? 'specbridge/mappings.yaml',
    policies: {
      formalVerificationRequired: raw.policies?.formalVerificationRequired ?? [],
      singleProvider: raw.policies?.singleProvider ?? true,
      impactMaxDepth: raw.policies?.impactMaxDepth ?? 4,
      impactMaxNodes: raw.policies?.impactMaxNodes ?? 500,
    },
    alloyProjections: raw.alloyProjections ?? [],
  }
}

export function globMatch(pattern: string, s: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  return re.test(s)
}
