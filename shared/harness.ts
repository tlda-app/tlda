export type Kind = 'claude' | 'codex' | 'goose'

export type TrustTier = 'full' | 'elevated' | 'narrow'
export type ModelFamily = Kind | 'gpt' | 'unknown' | (string & {})

export interface HarnessOps {
  kind: Kind
  channelNudge: boolean
  nudgeSettleMs: number
  educationGate: boolean
  requiresClaudeSession: boolean
  filtersSkillSections: boolean
  // The harness's natural on-disk skills directory — where THIS harness's agents
  // read SKILL.md from. The skill gate points an agent here instead of at any one
  // machine's checkout path, so it stays portable: each box symlinks its skills
  // into the harness-native place. A leading '~/' is the agent's home dir; a
  // relative path (goose) resolves against the agent's workspace.
  skillsDir: string
  modelFamily(model?: string | null): ModelFamily
  trustTier(model?: string | null): TrustTier
}

export interface ModelClassification {
  model: string
  kind: string
  family: ModelFamily
  trustTier: TrustTier
  isClaudeModel: boolean
  isOpenAiModel: boolean
}

const CLAUDE_MODEL_NAMES = new Set(['opus', 'opus45', 'opus46', 'opus47', 'opus48', 'fable', 'fable5', 'sonnet', 'sonnet5', 'haiku'])
const MODEL_ALIASES = new Map<string, string>([
  ['opus', 'claude-opus-4-8'],
  ['opus45', 'claude-opus-4-5'],
  ['opus46', 'claude-opus-4-6'],
  ['opus47', 'claude-opus-4-7'],
  ['opus48', 'claude-opus-4-8'],
  ['fable', 'claude-opus-4-8'],
  ['fable5', 'claude-opus-4-5'],
  ['sonnet', 'claude-sonnet-5'],
  ['sonnet5', 'claude-sonnet-5'],
  ['haiku', 'claude-haiku'],
  ['gpt', 'gpt-5.5'],
  ['deepseek', 'deepseek/deepseek-v4-pro'],
  ['deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
])

export function assertNever(value: never): never {
  throw new Error(`Unhandled harness kind: ${String(value)}`)
}

function normalize(value: unknown): string {
  return String(value || '').toLowerCase()
}

export function isClaudeModel(model: unknown): boolean {
  const m = normalize(model)
  return m.startsWith('claude-') || CLAUDE_MODEL_NAMES.has(m)
}

export function isOpenAiModel(model: unknown): boolean {
  const m = normalize(model)
  return m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m.includes('openai') || m.includes('codex')
}

export function classifyModel({ model, kind }: { model?: unknown; kind?: unknown } = {}): ModelClassification {
  const m = normalize(model)
  const k = normalize(kind)
  return {
    model: m,
    kind: k,
    family: modelFamily({ model: m, kind: k }),
    trustTier: modelTrustTier({ model: m, kind: k }),
    isClaudeModel: isClaudeModel(m),
    isOpenAiModel: isOpenAiModel(m),
  }
}

export function canonicalModel(model?: unknown, kind?: unknown): string {
  const m = normalize(model).replace(/\[[^\]]+\]$/u, '')
  if (!m) return ''
  const aliased = MODEL_ALIASES.get(m) || m
  const family = modelFamily({ model: aliased, kind })
  return `${family}:${aliased}`
}

export function modelFamily({ model, kind }: { model?: unknown; kind?: unknown } = {}): ModelFamily {
  const k = normalize(kind)
  const m = normalize(model)
  if (k) return k
  if (!m) return 'goose'
  if (m.includes('/')) return 'goose'
  if (isClaudeModel(m)) return 'claude'
  if (m.startsWith('gpt-') || m.startsWith('o') || m.includes('openai')) return 'gpt'
  if (m.includes('deepseek') || m.includes('qwen') || m.includes('kimi') || m.includes('glm') || m.includes('minimax')) return 'goose'
  return 'unknown'
}

export function modelTrustTier({ model, kind }: { model?: unknown; kind?: unknown } = {}): TrustTier {
  const m = normalize(model)
  const k = normalize(kind)
  if (m) {
    if (isClaudeModel(m) || isOpenAiModel(m)) return 'full'
    if (m.includes('minimax')) return 'elevated'
    return 'narrow'
  }
  if (k === 'claude' || k === 'codex' || k === 'gpt') return 'full'
  return 'narrow'
}

export const HARNESS: Record<Kind, HarnessOps> = {
  claude: {
    kind: 'claude',
    channelNudge: false,
    nudgeSettleMs: 0,
    educationGate: false,
    requiresClaudeSession: true,
    filtersSkillSections: false,
    skillsDir: '~/.claude/skills',
    modelFamily: (model) => modelFamily({ model, kind: 'claude' }),
    trustTier: (model) => modelTrustTier({ model, kind: 'claude' }),
  },
  codex: {
    kind: 'codex',
    channelNudge: true,
    nudgeSettleMs: 400,
    educationGate: true,
    requiresClaudeSession: false,
    filtersSkillSections: true,
    skillsDir: '~/.codex/skills',
    modelFamily: (model) => modelFamily({ model, kind: 'codex' }),
    trustTier: (model) => modelTrustTier({ model, kind: 'codex' }),
  },
  goose: {
    kind: 'goose',
    channelNudge: true,
    nudgeSettleMs: 0,
    educationGate: true,
    requiresClaudeSession: false,
    filtersSkillSections: true,
    skillsDir: '.agents/skills',
    modelFamily: (model) => modelFamily({ model, kind: 'goose' }),
    trustTier: (model) => modelTrustTier({ model, kind: 'goose' }),
  },
}

export function isKind(value: unknown): value is Kind {
  return typeof value === 'string' && value in HARNESS
}

export function normalizeKind(value: unknown, fallback: Kind = 'claude'): Kind {
  const kind = normalize(value)
  if (isKind(kind)) return kind
  return fallback
}
