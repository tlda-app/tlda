import os from 'os'
import path from 'path'

export const SHARED_FLEET_SKILLS_DIR = path.join(os.homedir(), 'work', 'dot-claude', 'skills')

function normalizePath(filePath) {
  if (!filePath) return ''
  const raw = String(filePath)
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  return path.resolve(raw)
}

function skillNameFromBase(absPath, baseDir) {
  const base = normalizePath(baseDir)
  if (!absPath.startsWith(base + path.sep)) return null
  const rel = absPath.slice(base.length + 1)
  const parts = rel.split(path.sep)
  if (parts.length === 2 && parts[1] === 'SKILL.md' && parts[0]) return parts[0]
  return null
}

function skillNameFromAgentsSkills(absPath) {
  const parts = absPath.split(path.sep)
  for (let i = 0; i < parts.length - 3; i++) {
    if (parts[i] === '.agents' && parts[i + 1] === 'skills' && parts[i + 2] && parts[i + 3] === 'SKILL.md') {
      return parts[i + 2]
    }
  }
  return null
}

export function skillNameFromSkillMdPath(filePath) {
  const abs = normalizePath(filePath)
  if (!abs.endsWith(path.sep + 'SKILL.md')) return null
  const home = os.homedir()
  const bases = [
    path.join(home, '.claude', 'skills'),
    path.join(home, '.codex', 'skills'),
    SHARED_FLEET_SKILLS_DIR,
    path.join(home, '.agents', 'skills'),
    path.join(path.sep, 'etc', 'codex', 'skills'),
  ]
  for (const base of bases) {
    const name = skillNameFromBase(abs, base)
    if (name) return name
  }
  return skillNameFromAgentsSkills(abs)
}

export function skillKeyFromSkillMdPath(filePath) {
  const name = skillNameFromSkillMdPath(filePath)
  return name ? `skill:${name}` : null
}
