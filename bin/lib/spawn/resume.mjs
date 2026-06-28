import fs from 'fs'
import os from 'os'
import path from 'path'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_SCAN_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
const REGISTER_RE = /Registered (fleet:\w+)/
const NAME_RE = /Your name: "([^"]+)"/

function claudeProjectsBase(base) {
  return base || path.join(os.homedir(), '.claude', 'projects')
}

function codexSessionsBase(base) {
  return base || path.join(os.homedir(), '.codex', 'sessions')
}

function walkFiles(root, accept) {
  const out = []
  function visit(dir) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (accept(full, entry.name)) out.push(full)
    }
  }
  visit(root)
  return out
}

export function claudeJsonlPath(sessionId, { projectsBase } = {}) {
  const base = claudeProjectsBase(projectsBase)
  if (!sessionId || !fs.existsSync(base)) return null
  for (const dir of fs.readdirSync(base, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const f = path.join(base, dir.name, `${sessionId}.jsonl`)
    if (fs.existsSync(f)) return f
  }
  return null
}

export function jsonlPathToCwd(jsonlPath) {
  const projectDir = path.basename(path.dirname(jsonlPath))
  if (!projectDir.startsWith('-')) return null
  const parts = projectDir.slice(1).split('-')
  let current = ''
  for (let i = 0; i < parts.length; i += 1) {
    const candidate = `${current}/${parts[i]}`
    if (fs.existsSync(candidate)) {
      current = candidate
      continue
    }
    const rest = parts.slice(i).join('-')
    const hyphenCandidate = `${current}/${rest}`
    if (fs.existsSync(hyphenCandidate)) return hyphenCandidate
    break
  }
  return fs.existsSync(current) ? current : null
}

function scanClaudeJsonlIdentity(fpath) {
  let fleetId = null
  let agentName = null
  let cwd = null
  try {
    for (const line of fs.readFileSync(fpath, 'utf8').split(/\n/)) {
      if (fleetId && cwd) break
      let parsed = null
      if ((cwd == null && line.includes('"cwd"')) || line.includes('Registered fleet:')) {
        try {
          parsed = JSON.parse(line)
        } catch {
          parsed = null
        }
      }
      if (cwd == null && parsed?.cwd && fs.existsSync(parsed.cwd)) cwd = parsed.cwd
      if (fleetId != null || !line.includes('Registered fleet:')) continue
      if (!parsed) continue
      const result = parsed.toolUseResult
      if (!result) continue
      const items = Array.isArray(result) ? result : [result]
      for (const item of items) {
        const text = item && typeof item === 'object' ? (item.text || '') : String(item)
        const m = REGISTER_RE.exec(text)
        if (!m) continue
        fleetId = m[1]
        agentName = NAME_RE.exec(text)?.[1] || null
        break
      }
    }
  } catch {
    // Corrupt or racing JSONL files are skipped; other resume handles may exist.
  }
  return { fleetId, agentName, cwd }
}

export function scanClaudeSessionIdentity(sessionId, { projectsBase } = {}) {
  const jsonlPath = claudeJsonlPath(sessionId, { projectsBase })
  if (!jsonlPath) return null
  const identity = scanClaudeJsonlIdentity(jsonlPath)
  return { ...identity, jsonlPath, cwd: identity.cwd || jsonlPathToCwd(jsonlPath) }
}

export function findClaudeSession(agent, { projectsBase, sessionOverride } = {}) {
  const primary = sessionOverride || agent?.session_id
  if (primary) {
    const p = claudeJsonlPath(primary, { projectsBase })
    if (p) {
      const identity = scanClaudeJsonlIdentity(p)
      return { kind: 'claude', sessionId: primary, jsonlPath: p, cwd: identity.cwd || jsonlPathToCwd(p) }
    }
  }
  let ids = agent?.session_ids || agent?.sessions || []
  if (typeof ids === 'string') {
    try {
      ids = JSON.parse(ids || '[]')
    } catch {
      ids = []
    }
  }
  for (const sid of [...(Array.isArray(ids) ? ids : [])].reverse()) {
    if (!sid || sid === primary) continue
    const p = claudeJsonlPath(sid, { projectsBase })
    if (p) {
      const identity = scanClaudeJsonlIdentity(p)
      return { kind: 'claude', sessionId: sid, jsonlPath: p, cwd: identity.cwd || jsonlPathToCwd(p) }
    }
  }
  const base = claudeProjectsBase(projectsBase)
  const fleetId = agent?.id
  if (!fleetId || !fs.existsSync(base)) return null
  const candidates = []
  for (const fpath of walkFiles(base, (_full, name) => name.endsWith('.jsonl'))) {
    const identity = scanClaudeJsonlIdentity(fpath)
    if (identity.fleetId !== fleetId) continue
    let st
    try {
      st = fs.statSync(fpath)
    } catch {
      continue
    }
    candidates.push({ sessionId: path.basename(fpath, '.jsonl'), mtime: st.mtimeMs, fpath, cwd: identity.cwd || jsonlPathToCwd(fpath) })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  const best = candidates[0]
  return best ? { kind: 'claude', sessionId: best.sessionId, jsonlPath: best.fpath, cwd: best.cwd } : null
}

export function codexRolloutPath(rolloutId, { sessionsBase } = {}) {
  const base = codexSessionsBase(sessionsBase)
  if (!rolloutId || !fs.existsSync(base)) return null
  return walkFiles(base, (_full, name) => name.startsWith('rollout-') && name.endsWith(`${rolloutId}.jsonl`))[0] || null
}

export function scanCodexRolloutIdentity(fpath) {
  let ownId = null
  let agentName = null
  let meta = null
  try {
    for (const line of fs.readFileSync(fpath, 'utf8').split(/\n/)) {
      if (meta == null && line.includes('"session_meta"')) {
        try {
          meta = JSON.parse(line).payload || {}
        } catch {
          meta = {}
        }
      }
      if (ownId == null && line.includes('Registered fleet:')) {
        const m = REGISTER_RE.exec(line)
        if (m) {
          ownId = m[1]
          agentName = NAME_RE.exec(line)?.[1] || null
        }
      }
      if (ownId != null && meta != null) break
    }
  } catch {
    // Corrupt or racing rollout files are skipped; ownership falls back to null.
  }
  return { ownId, agentName, sessionMeta: meta || {} }
}

export function findCodexRollout(agent, { sessionsBase, sessionOverride } = {}) {
  if (sessionOverride) {
    const fpath = codexRolloutPath(sessionOverride, { sessionsBase })
    if (!fpath) return null
    const { sessionMeta } = scanCodexRolloutIdentity(fpath)
    return { kind: 'codex', rolloutId: sessionOverride, jsonlPath: fpath, cwd: sessionMeta.cwd, sessionMeta }
  }
  const base = codexSessionsBase(sessionsBase)
  const fleetId = agent?.id
  if (!fleetId || !fs.existsSync(base)) return null
  const candidates = []
  for (const fpath of walkFiles(base, (_full, name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))) {
    const { ownId, sessionMeta } = scanCodexRolloutIdentity(fpath)
    if (ownId !== fleetId) continue
    let st
    try {
      st = fs.statSync(fpath)
    } catch {
      continue
    }
    const rolloutId = sessionMeta.id || UUID_SCAN_RE.exec(path.basename(fpath))?.[1]
    if (rolloutId) candidates.push({ rolloutId, fpath, mtime: st.mtimeMs, sessionMeta })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  const best = candidates[0]
  return best ? { kind: 'codex', rolloutId: best.rolloutId, jsonlPath: best.fpath, cwd: best.sessionMeta.cwd, sessionMeta: best.sessionMeta } : null
}

export function stripSyntheticTail(sessionId, { projectsBase } = {}) {
  const fpath = claudeJsonlPath(sessionId, { projectsBase })
  if (!fpath) return { stripped: 0, path: null }
  let lines
  try {
    lines = fs.readFileSync(fpath, 'utf8').split(/(?<=\n)/)
  } catch {
    return { stripped: 0, path: fpath }
  }
  let stripped = 0
  while (lines.length) {
    const line = lines[lines.length - 1].trim()
    if (!line) {
      lines.pop()
      stripped += 1
      continue
    }
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      break
    }
    const msg = entry?.message || {}
    if (entry?.type === 'assistant' && (String(msg.model || '').includes('<synthetic>') || (msg.id && UUID_RE.test(msg.id)))) {
      lines.pop()
      stripped += 1
      continue
    }
    break
  }
  if (stripped) fs.writeFileSync(fpath, lines.join(''))
  return { stripped, path: fpath }
}
