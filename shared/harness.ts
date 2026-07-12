export type Kind = 'claude' | 'codex' | 'goose'

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
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled harness kind: ${String(value)}`)
}

function normalize(value: unknown): string {
  return String(value || '').toLowerCase()
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
  },
  codex: {
    kind: 'codex',
    channelNudge: true,
    nudgeSettleMs: 400,
    educationGate: true,
    requiresClaudeSession: false,
    filtersSkillSections: true,
    skillsDir: '~/.codex/skills',
  },
  goose: {
    kind: 'goose',
    channelNudge: true,
    nudgeSettleMs: 0,
    educationGate: true,
    requiresClaudeSession: false,
    filtersSkillSections: true,
    skillsDir: '.agents/skills',
  },
}

export function isKind(value: unknown): value is Kind {
  return typeof value === 'string' && value in HARNESS
}

export function normalizeKind(value: unknown): Kind {
  const kind = normalize(value)
  if (isKind(kind)) return kind
  throw new Error(`Unknown harness kind: ${String(value)}`)
}
