import os from 'os'
import path from 'path'

const SCRATCHPAD_ENV_KEYS = [
  'CLAUDE_CODE_SCRATCHPAD',
  'CLAUDE_CODE_SCRATCHPAD_ROOT',
  'CLAUDE_SCRATCHPAD',
  'CLAUDE_SCRATCHPAD_ROOT',
  'ANTHROPIC_SCRATCHPAD',
  'ANTHROPIC_SCRATCHPAD_ROOT',
  'MCP_SCRATCHPAD',
  'MCP_SCRATCHPAD_ROOT',
  'HARNESS_SCRATCHPAD',
  'HARNESS_SCRATCHPAD_ROOT',
]

function expandUser(value) {
  const str = String(value || '')
  if (str === '~') return os.homedir()
  if (str.startsWith('~/')) return path.join(os.homedir(), str.slice(2))
  return str
}

function absPath(value) {
  const expanded = expandUser(value)
  if (!expanded) return null
  return path.resolve(expanded)
}

function addPathAndContents(roots, value) {
  const root = absPath(value)
  if (!root || root === path.parse(root).root) return
  roots.push(root, path.join(root, '**'))
}

function addScratchpadRoots(roots, env) {
  for (const key of SCRATCHPAD_ENV_KEYS) {
    const value = env?.[key]
    if (!value) continue
    const root = absPath(value)
    if (!root || root === path.parse(root).root) continue
    // Claude creates the scratchpad directory lazily. Allow the per-session
    // parent too, so mkdir of the scratchpad itself is not blocked.
    addPathAndContents(roots, path.dirname(root))
    addPathAndContents(roots, root)
  }
}

export function harnessStateWriteRoots(env = process.env) {
  const roots = []
  addPathAndContents(roots, env?.CODEX_HOME || path.join(os.homedir(), '.codex'))
  addPathAndContents(roots, env?.CLAUDE_HOME || path.join(os.homedir(), '.claude'))
  addScratchpadRoots(roots, env)
  addPathAndContents(roots, env?.TMPDIR || os.tmpdir())
  return [...new Set(roots)].sort()
}
