import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  skillKeyFromSkillMdPath,
  skillNameFromSkillMdPath,
} from '../shared/skill-paths.mjs'

const home = os.homedir()

test('maps recognized SKILL.md locations to skill names and keys', () => {
  const cases = [
    [path.join(home, '.claude', 'skills', 'writing-core', 'SKILL.md'), 'writing-core'],
    [path.join(home, 'work', 'dot-claude', 'skills', 'self-sufficiency', 'SKILL.md'), 'self-sufficiency'],
    [path.join(home, '.agents', 'skills', 'proof-smells', 'SKILL.md'), 'proof-smells'],
    ['/etc/codex/skills/tooling/SKILL.md', 'tooling'],
    ['/Users/skip/work/tlda/.agents/skills/app-review/SKILL.md', 'app-review'],
    ['~/work/dot-claude/skills/math-report/SKILL.md', 'math-report'],
  ]

  for (const [file, name] of cases) {
    assert.equal(skillNameFromSkillMdPath(file), name)
    assert.equal(skillKeyFromSkillMdPath(file), `skill:${name}`)
  }
})

test('rejects non-skill files and nested files under skill directories', () => {
  assert.equal(skillNameFromSkillMdPath(path.join(home, 'work', 'dot-claude', 'skills', 'x', 'README.md')), null)
  assert.equal(skillNameFromSkillMdPath(path.join(home, 'work', 'dot-claude', 'skills', 'x', 'refs', 'SKILL.md')), null)
  assert.equal(skillKeyFromSkillMdPath('/tmp/random/SKILL.md'), null)
})
