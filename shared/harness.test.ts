import assert from 'node:assert/strict'
import test from 'node:test'
import { HARNESS, classifyModel, isClaudeModel, isOpenAiModel, modelFamily, modelTrustTier } from './harness.ts'

const kinds = ['claude', 'codex', 'goose'] as const
const models = [
  '',
  'opus',
  'opus45',
  'opus46',
  'opus47',
  'opus48',
  'fable',
  'fable5',
  'sonnet',
  'haiku',
  'claude-3-5-sonnet',
  'claude-opus-4-5',
  'claude-opus-4-6[1m]',
  'claude-opus-4-7[1m]',
  'claude-opus-4-8[1m]',
  'claude-fable-5[1m]',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'gpt-5.5',
  'gpt-4o',
  'o1',
  'o3-mini',
  'o4-mini',
  'openai/gpt-oss-120b',
  'codex',
  'deepseek',
  'deepseek/deepseek-v4-pro',
  'qwen3-coder',
  'qwen',
  'qwen3.7-max',
  'qwen/qwen3.7-max',
  'kimi-k2',
  'kimi',
  'kimi-k2.7',
  'moonshotai/kimi-k2.7-code',
  'glm-4.5',
  'glm',
  'glm-5.1',
  'z-ai/glm-5.1',
  'minimax',
  'minimax-m3',
  'minimax/minimax-m2',
  'minimax/minimax-m3',
  'gemini',
  'gemini-3.5-flash',
  'google/gemini-3.5-flash',
  'mistral',
  'mistral-medium-3-5',
  'mistralai/mistral-medium-3-5',
  'unknown-model',
] as const

const legacyClaudeNames = new Set(['opus', 'opus45', 'opus46', 'opus47', 'opus48', 'fable', 'fable5', 'sonnet', 'haiku'])

function legacyIsClaudeModel(m: string): boolean {
  return m.startsWith('claude-') || legacyClaudeNames.has(m)
}

function legacyIsOpenAiModel(m: string): boolean {
  return m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m.includes('openai') || m.includes('codex')
}

function legacyModelFamily({ model, kind }: { model?: unknown; kind?: unknown } = {}): string {
  const k = String(kind || '').toLowerCase()
  const m = String(model || '').toLowerCase()
  if (k) return k
  if (!m) return 'goose'
  if (m.includes('/')) return 'goose'
  if (m.startsWith('claude-') || legacyClaudeNames.has(m)) return 'claude'
  if (m.startsWith('gpt-') || m.startsWith('o') || m.includes('openai')) return 'gpt'
  if (m.includes('deepseek') || m.includes('qwen') || m.includes('kimi') || m.includes('glm') || m.includes('minimax')) return 'goose'
  return 'unknown'
}

function legacyModelTrustTier({ model, kind }: { model?: unknown; kind?: unknown } = {}): string {
  const m = String(model || '').toLowerCase()
  const k = String(kind || '').toLowerCase()
  if (m) {
    if (legacyIsClaudeModel(m) || legacyIsOpenAiModel(m)) return 'full'
    if (m.includes('minimax')) return 'elevated'
    return 'narrow'
  }
  if (k === 'claude' || k === 'codex' || k === 'gpt') return 'full'
  return 'narrow'
}

test('HARNESS preserves the existing adapter behavior with capability flags', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(HARNESS).map(([kind, ops]) => [kind, {
      kind: ops.kind,
      channelNudge: ops.channelNudge,
      nudgeSettleMs: ops.nudgeSettleMs,
      educationGate: ops.educationGate,
      requiresClaudeSession: ops.requiresClaudeSession,
      filtersSkillSections: ops.filtersSkillSections,
    }])),
    {
      claude: {
        kind: 'claude',
        channelNudge: false,
        nudgeSettleMs: 0,
        educationGate: false,
        requiresClaudeSession: true,
        filtersSkillSections: false,
      },
      codex: {
        kind: 'codex',
        channelNudge: true,
        nudgeSettleMs: 400,
        educationGate: true,
        requiresClaudeSession: false,
        filtersSkillSections: true,
      },
      goose: {
        kind: 'goose',
        channelNudge: true,
        nudgeSettleMs: 0,
        educationGate: true,
        requiresClaudeSession: false,
        filtersSkillSections: true,
      },
    }
  )
})

test('model classification matches the legacy spawn-policy behavior', () => {
  const cases = [
    ...models.map((model) => ({ kind: undefined as string | undefined, model })),
    ...kinds.flatMap((kind) => models.map((model) => ({ kind, model }))),
    { kind: 'gpt', model: '' },
    { kind: 'unknown', model: '' },
  ]

  for (const entry of cases) {
    const model = String(entry.model || '').toLowerCase()
    assert.equal(modelFamily(entry), legacyModelFamily(entry), `family ${JSON.stringify(entry)}`)
    assert.equal(modelTrustTier(entry), legacyModelTrustTier(entry), `tier ${JSON.stringify(entry)}`)
    assert.equal(isClaudeModel(model), legacyIsClaudeModel(model), `claude ${JSON.stringify(entry)}`)
    assert.equal(isOpenAiModel(model), legacyIsOpenAiModel(model), `openai ${JSON.stringify(entry)}`)
    assert.deepEqual(classifyModel(entry), {
      model,
      kind: String(entry.kind || '').toLowerCase(),
      family: legacyModelFamily(entry),
      trustTier: legacyModelTrustTier(entry),
      isClaudeModel: legacyIsClaudeModel(model),
      isOpenAiModel: legacyIsOpenAiModel(model),
    })
  }
})
