import fs from 'fs'
import os from 'os'
import path from 'path'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_SCAN_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
const LOGIN_RE = /(?:Logged in|Registered) (fleet:[A-Za-z0-9_-]+)/
const NAME_RE = /Your name: "([^"]+)"/

function claudeProjectsBase(base) {
  return base || path.join(os.homedir(), '.claude', 'projects')
}

function codexSessionsBase(base) {
  return base || path.join(os.homedir(), '.codex', 'sessions')
}

export function isRespawnIdentityCaughtUp(_options = {}) {
  return true
}

function indexedSessionRecord(_sessionId, _options = {}) {
  return null
}

function indexedSessionRecords(_agent, _kind, _options = {}) {
  return []
}

function validIdentityRecord(rec, agent, kind) {
  if (!rec?.session_id) return false
  if (kind && rec.harness_kind && rec.harness_kind !== kind) return false
  if (agent?.id && rec.fleet_id && rec.fleet_id !== agent.id) return false
  return true
}

function findClaudeSessionByFleetId(agent, { projectsBase } = {}) {
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

export function findClaudeSession(agent, options = {}) {
  const { projectsBase, sessionOverride } = options
  const primary = sessionOverride || agent?.session_id
  if (primary) {
    const rec = indexedSessionRecord(primary, options)
    if (rec) {
      if (!validIdentityRecord(rec, agent, 'claude')) {
        if (sessionOverride) return null
      } else {
        const p = rec.jsonl_path && fs.existsSync(rec.jsonl_path)
          ? rec.jsonl_path
          : claudeJsonlPath(primary, { projectsBase })
        if (p) return { kind: 'claude', sessionId: primary, jsonlPath: p, cwd: rec.cwd || jsonlPathToCwd(p) }
      }
    }
    const p = claudeJsonlPath(primary, { projectsBase })
    if (p) {
      const identity = scanClaudeJsonlIdentity(p)
      if (sessionOverride || !identity.fleetId || !agent?.id || identity.fleetId === agent.id) {
        return { kind: 'claude', sessionId: primary, jsonlPath: p, cwd: identity.cwd || jsonlPathToCwd(p) }
      }
    }
  }
  for (const rec of indexedSessionRecords(agent, 'claude', options)) {
    const p = rec.jsonl_path && fs.existsSync(rec.jsonl_path)
      ? rec.jsonl_path
      : claudeJsonlPath(rec.session_id, { projectsBase })
    if (p) return { kind: 'claude', sessionId: rec.session_id, jsonlPath: p, cwd: rec.cwd || jsonlPathToCwd(p) }
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
      if (!identity.fleetId || !agent?.id || identity.fleetId === agent.id) {
        return { kind: 'claude', sessionId: sid, jsonlPath: p, cwd: identity.cwd || jsonlPathToCwd(p) }
      }
    }
  }
  const owned = findClaudeSessionByFleetId(agent, { projectsBase })
  if (owned) return owned
  if (!isRespawnIdentityCaughtUp(options)) return null
  return null
}

export function codexRolloutPath(rolloutId, { sessionsBase } = {}) {
  const base = codexSessionsBase(sessionsBase)
  if (!rolloutId || !fs.existsSync(base)) return null
  return walkFiles(base, (_full, name) => name.startsWith('rollout-') && name.endsWith(`${rolloutId}.jsonl`))[0] || null
}

function textPartsFromToolResult(value) {
  const out = []
  function visit(item) {
    if (item == null) return
    if (typeof item === 'string') {
      out.push(item)
      return
    }
    if (Array.isArray(item)) {
      for (const part of item) visit(part)
      return
    }
    if (typeof item !== 'object') return
    if (typeof item.text === 'string') out.push(item.text)
    if (typeof item.output === 'string') out.push(item.output)
    if (typeof item.content === 'string') out.push(item.content)
    if (Array.isArray(item.content)) visit(item.content)
    if (item.Ok) visit(item.Ok)
    if (item.Err) visit(item.Err)
  }
  visit(value)
  return out
}

function parseLoginText(text) {
  const m = LOGIN_RE.exec(text || '')
  if (!m) return null
  return { ownId: m[1], agentName: NAME_RE.exec(text)?.[1] || null }
}

function parseFleetEnvText(text) {
  const ownId = /^FLEET_ID=(fleet:[A-Za-z0-9_-]+)/m.exec(text || '')?.[1] || null
  if (!ownId) return null
  const agentName = /^FLEET_NAME=([^\r\n]+)/m.exec(text || '')?.[1]?.trim() || null
  return { ownId, agentName }
}

function codexCommandReadsFleetEnv(payload) {
  if (payload?.type !== 'function_call' || payload.name !== 'exec_command') return false
  let args
  try {
    args = JSON.parse(payload.arguments || '{}')
  } catch {
    return false
  }
  const cmd = String(args.cmd || '').trim()
  if (!cmd) return false
  return /^(?:printenv|env)(?:\s|\||$)/.test(cmd) && /\bFLEET\b/.test(cmd)
}

function codexRolloutMatchesAgentLaunch(agent, sessionMeta) {
  if (!agent?.cwd || !sessionMeta?.cwd || agent.cwd !== sessionMeta.cwd) return false
  const launchTs = Date.parse(agent.registered_at || '')
  const rolloutTs = Date.parse(sessionMeta.timestamp || '')
  if (!Number.isFinite(launchTs) || !Number.isFinite(rolloutTs)) return false
  return codexRolloutLaunchDistanceMs(agent, sessionMeta) != null
}

function codexRolloutLaunchDistanceMs(agent, sessionMeta) {
  if (!agent?.cwd || !sessionMeta?.cwd || agent.cwd !== sessionMeta.cwd) return null
  const launchTs = Date.parse(agent.registered_at || '')
  const rolloutTs = Date.parse(sessionMeta.timestamp || '')
  if (!Number.isFinite(launchTs) || !Number.isFinite(rolloutTs)) return null
  const delta = rolloutTs - launchTs
  if (delta < -5_000 || delta > 10 * 60_000) return null
  return Math.abs(delta)
}

export function scanCodexRolloutIdentity(fpath) {
  let ownId = null
  let agentName = null
  let meta = null
  const loginCalls = new Set()
  const fleetEnvCalls = new Set()
  try {
    for (const line of fs.readFileSync(fpath, 'utf8').split(/\n/)) {
      if (meta == null && line.includes('"session_meta"')) {
        try {
          meta = JSON.parse(line).payload || {}
        } catch {
          meta = {}
        }
      }
      let parsed = null
      if (ownId == null && (line.includes('"function_call"') || line.includes('"function_call_output"') || line.includes('"mcp_tool_call_end"'))) {
        try {
          parsed = JSON.parse(line)
        } catch {
          parsed = null
        }
      }
      const payload = parsed?.payload || {}
      if (payload.type === 'function_call' && payload.namespace === 'mcp__tlda' && payload.name === 'login' && payload.call_id) {
        loginCalls.add(payload.call_id)
      }
      if (payload.call_id && codexCommandReadsFleetEnv(payload)) {
        fleetEnvCalls.add(payload.call_id)
      }
      if (ownId == null && payload.type === 'function_call_output' && loginCalls.has(payload.call_id)) {
        const output = typeof payload.output === 'string' ? payload.output
          : (payload.output && typeof payload.output.content === 'string' ? payload.output.content : '')
        const login = parseLoginText(output)
        if (login) {
          ownId = login.ownId
          agentName = login.agentName
        }
      }
      if (ownId == null && payload.type === 'function_call_output' && fleetEnvCalls.has(payload.call_id)) {
        const output = typeof payload.output === 'string' ? payload.output
          : (payload.output && typeof payload.output.content === 'string' ? payload.output.content : '')
        const envIdentity = parseFleetEnvText(output)
        if (envIdentity) {
          ownId = envIdentity.ownId
          agentName = envIdentity.agentName
        }
      }
      if (ownId == null && payload.type === 'mcp_tool_call_end' && payload.invocation?.server === 'tlda' && payload.invocation?.tool === 'login') {
        for (const text of textPartsFromToolResult(payload.result)) {
          const login = parseLoginText(text)
          if (!login) continue
          ownId = login.ownId
          agentName = login.agentName
          break
        }
      }
      if (ownId != null && meta != null) break
    }
  } catch {
    // Corrupt or racing rollout files are skipped; ownership falls back to null.
  }
  return { ownId, agentName, sessionMeta: meta || {} }
}

export function findCodexRollout(agent, options = {}) {
  const { sessionsBase, sessionOverride } = options
  if (sessionOverride) {
    const rec = indexedSessionRecord(sessionOverride, options)
    if (rec) {
      if (!validIdentityRecord(rec, agent, 'codex')) return null
      const fpath = rec.jsonl_path && fs.existsSync(rec.jsonl_path)
        ? rec.jsonl_path
        : codexRolloutPath(sessionOverride, { sessionsBase })
      if (!fpath) return null
      const { sessionMeta } = scanCodexRolloutIdentity(fpath)
      return { kind: 'codex', rolloutId: sessionOverride, jsonlPath: fpath, cwd: rec.cwd || sessionMeta.cwd, sessionMeta }
    }
    const fpath = codexRolloutPath(sessionOverride, { sessionsBase })
    if (!fpath) return null
    const { sessionMeta } = scanCodexRolloutIdentity(fpath)
    return { kind: 'codex', rolloutId: sessionOverride, jsonlPath: fpath, cwd: sessionMeta.cwd, sessionMeta }
  }
  for (const rec of indexedSessionRecords(agent, 'codex', options)) {
    const fpath = rec.jsonl_path && fs.existsSync(rec.jsonl_path)
      ? rec.jsonl_path
      : codexRolloutPath(rec.session_id, { sessionsBase })
    if (!fpath) continue
    const { sessionMeta } = scanCodexRolloutIdentity(fpath)
    return { kind: 'codex', rolloutId: rec.session_id, jsonlPath: fpath, cwd: rec.cwd || sessionMeta.cwd, sessionMeta }
  }
  if (!isRespawnIdentityCaughtUp(options)) return null
  const base = codexSessionsBase(sessionsBase)
  const fleetId = agent?.id
  if (!fleetId || !fs.existsSync(base)) return null

  let ids = agent?.session_ids || agent?.sessions || []
  if (typeof ids === 'string') {
    try {
      ids = JSON.parse(ids || '[]')
    } catch {
      ids = []
    }
  }
  const knownIds = []
  if (agent?.session_id) knownIds.push(agent.session_id)
  for (const sid of (Array.isArray(ids) ? ids : [])) {
    if (sid && !knownIds.includes(sid)) knownIds.push(sid)
  }
  for (const rolloutId of knownIds) {
    const fpath = codexRolloutPath(rolloutId, { sessionsBase })
    if (!fpath) continue
    const { ownId, sessionMeta } = scanCodexRolloutIdentity(fpath)
    if (ownId && ownId !== fleetId) continue
    return { kind: 'codex', rolloutId, jsonlPath: fpath, cwd: sessionMeta.cwd, sessionMeta }
  }

  const candidates = []
  const ownerlessLaunchCandidates = []
  for (const fpath of walkFiles(base, (_full, name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))) {
    const { ownId, sessionMeta } = scanCodexRolloutIdentity(fpath)
    let st
    try {
      st = fs.statSync(fpath)
    } catch {
      continue
    }
    const rolloutId = sessionMeta.id || UUID_SCAN_RE.exec(path.basename(fpath))?.[1]
    if (!rolloutId) continue
    if (ownId === fleetId) {
      candidates.push({ rolloutId, fpath, mtime: st.mtimeMs, sessionMeta })
    } else if (ownId == null && codexRolloutMatchesAgentLaunch(agent, sessionMeta)) {
      ownerlessLaunchCandidates.push({
        rolloutId,
        fpath,
        mtime: st.mtimeMs,
        launchDistance: codexRolloutLaunchDistanceMs(agent, sessionMeta),
        sessionMeta,
      })
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  ownerlessLaunchCandidates.sort((a, b) => (a.launchDistance - b.launchDistance) || (b.mtime - a.mtime))
  const best = candidates[0] || ownerlessLaunchCandidates[0]
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
