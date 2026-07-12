import assert from 'node:assert/strict'
import test from 'node:test'
import { HARNESS } from './harness.ts'

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
