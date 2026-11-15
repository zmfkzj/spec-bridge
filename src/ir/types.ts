// Semantic IR: a regenerable, file-backed model DERIVED from the authoritative specs.
// It never replaces the sources; deleting .specbridge/ and rebuilding from the specs plus
// specbridge/mappings.yaml must reproduce it (except timestamps/durations).

export const IR_SCHEMA_VERSION = '1.0.0'

export type Tool = 'openspec' | 'likec4' | 'typespec' | 'alloy' | 'oasdiff' | 'specbridge'

/** Base entity types required by the spec, plus documented extensions. */
export const ENTITY_TYPES = [
  'Requirement', 'Scenario', 'Component', 'Interface', 'Operation', 'DataType', 'Constraint', 'State', 'Transition', 'Invariant',
  // extensions (documented in docs/ir.md)
  'Field', 'Predicate', 'Command', 'Change', 'Flow', 'DeploymentNode',
] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

export const RELATION_TYPES = [
  'REQUIRES', 'SATISFIES', 'IMPLEMENTS', 'DEPENDS_ON', 'EXPOSES', 'CONSUMES', 'OWNS', 'CONSTRAINS', 'TRANSITIONS_TO', 'VERIFIES', 'CONFLICTS_WITH', 'IMPACTS',
  // extensions
  'CONTAINS', 'REFERENCES', 'EXTENDS', 'CORRESPONDS_TO', 'DEPLOYS', 'CHANGES',
] as const
export type RelationType = (typeof RELATION_TYPES)[number]

/** Trust separation (spec 4.3). Only Explicit and Derived count as facts. */
export type Trust = 'Explicit' | 'Derived' | 'Proposed' | 'Rejected'
export const FACT_TRUST: ReadonlySet<Trust> = new Set(['Explicit', 'Derived'])

export type ExtractionMethod =
  | 'cli-json'          // official CLI structured output (openspec show --json)
  | 'compiler-api'      // TypeSpec compiler program/type graph
  | 'model-api'         // LikeC4 LikeC4.fromWorkspace().computedModel()
  | 'java-api'          // Alloy CompUtil / TranslateAlloyToKodkod
  | 'tool-json'         // oasdiff --format json
  | 'source-locator'    // SpecBridge text locator used ONLY to find line numbers
  | 'scn-pattern'       // SpecBridge Constraint Notation (controlled language) parser
  | 'derived-rule'      // deterministic SpecBridge rule over extracted facts
  | 'approved-mapping'  // specbridge/mappings.yaml entry with status approved
  | 'heuristic'         // similarity heuristic (proposals only)
  | 'ai'                // AI provider (proposals only)

export interface SourceLocation {
  file: string            // workspace-relative path
  line?: number           // 1-based
  column?: number         // 1-based
  endLine?: number
  endColumn?: number
  locatedBy?: 'tool' | 'source-locator'  // whether the tool itself reported the position
}

export interface SourceVersion {
  tool: Tool
  toolVersion: string
  fileSha256?: string
  gitRevision?: string | null  // HEAD (or base ref) commit of the workspace; null when not a git tree
  gitDirty?: boolean
}

export interface Evidence {
  kind: 'source' | 'tool-output' | 'mapping' | 'rule' | 'execution' | 'proposal'
  detail: string
  location?: SourceLocation
  rule?: string
  reproduce?: string
}

export interface ExtractionInfo {
  method: ExtractionMethod
  adapter: string          // e.g. "openspec@1"
  lossy?: string[]         // information known to be lost/unsupported for this entity
}

export type ValidationStatus = 'tool-validated' | 'unvalidated' | 'invalid' | 'not-applicable'

export interface Entity {
  id: string               // stable SpecBridge id, e.g. "typespec:op:JobApi.Jobs.claimJob"
  type: EntityType
  name: string
  tool: Tool
  source: SourceLocation
  version: SourceVersion
  extraction: ExtractionInfo
  validation: { status: ValidationStatus; by?: string; messages?: string[] }
  trust: Trust
  /** Hash of the semantic content (not location). Same id + new fingerprint = modified. */
  fingerprint: string
  attrs: Record<string, unknown>
  evidence: Evidence[]
}

export interface Relation {
  id: string
  type: RelationType
  from: string
  to: string
  trust: Trust
  rule: string             // how it was established (e.g. "likec4.metadata.specbridge_provides")
  evidence: Evidence[]
  mappingId?: string       // approved mapping that produced it
  stale?: boolean          // produced by an approved mapping whose endpoints changed since approval
  attrs?: Record<string, unknown>
}

export type ConstraintKind =
  | 'Equality' | 'Inequality' | 'Cardinality' | 'Required' | 'Optional' | 'Range' | 'TypeCompatibility'
  | 'DependencyRestriction' | 'Ownership' | 'Exclusivity' | 'StateInvariant' | 'ErrorResponse'

export type Direction = 'request' | 'response' | 'stored' | 'any'

/** Normalized constraint; complex logic stays in Alloy and is only referenced (kind StateInvariant). */
export interface Constraint {
  id: string
  kind: ConstraintKind
  origin: string                 // entity id that states the constraint
  tool: Tool
  trust: Trust
  interpretation: 'structured' | 'scn-pattern' | 'alloy-reference' | 'uninterpreted'
  subject: {
    concept?: string             // normalized concept name, e.g. "Job" (resolved via TypeSpec / concept mappings)
    field?: string               // e.g. "owner"
    entity?: string              // resolved IR entity id of the field/type/component, if known
    operation?: string           // operation scope (entity id), if any
    direction: Direction
    state?: string               // state condition, e.g. "claimed"; undefined = all states
    conceptKey?: string          // canonical concept identity after linking (TypeSpec type id, or tool-local id)
    fieldKey?: string            // canonical field identity after linking (TypeSpec field id, or tool-local id)
  }
  params: {
    min?: number | null
    max?: number | null
    unit?: string | null         // normalized unit ("s", "ms", "byte"...) or null = unknown
    exclusiveMin?: boolean
    exclusiveMax?: boolean
    type?: string
    status?: number[]            // ErrorResponse status codes
    target?: string              // dependency / ownership target (entity id)
    owner?: string
    value?: string
    alloyRef?: string            // for alloy-reference constraints
  }
  text: string
  source: SourceLocation
  evidence: Evidence[]
}

export interface SourceRecord {
  tool: Tool
  toolVersion: string
  root: string
  files: { path: string; sha256: string }[]
  status: 'OK' | 'ERROR' | 'SKIPPED'
  diagnostics: { severity: 'error' | 'warning' | 'info'; message: string; location?: SourceLocation }[]
  lossy: string[]
  interface: string
}

export interface MappingStatusRecord {
  id: string
  type: RelationType
  from: string
  to: string
  status: 'approved' | 'rejected' | 'proposed'
  validity: 'VALID' | 'STALE' | 'INVALIDATED' | 'NOT_EVALUATED'
  reasons: string[]
  suggestion?: string
}

export interface ReferenceRecord {
  from: string
  ref: string
  relation: RelationType
  rule: string
  tool: Tool
  strict: boolean
  location: SourceLocation
  status: 'resolved' | 'ambiguous' | 'unresolved'
  target?: string
  resolution?: 'exact' | 'unique-suffix'
  candidates?: string[]
  /** Expected kind of the target (operation, component, ...) */
  expect: string[]
  via?: string
}

export interface SemanticIR {
  schemaVersion: string
  workspace: string
  git: { revision: string | null; dirty: boolean }
  sources: SourceRecord[]
  entities: Entity[]
  relations: Relation[]
  constraints: Constraint[]
  mappings: MappingStatusRecord[]
  references: ReferenceRecord[]
  diagnostics: { severity: 'error' | 'warning' | 'info'; message: string; code: string; location?: SourceLocation }[]
}
