import fs from 'fs'
import os from 'os'
import path from 'path'
import YAML from 'yaml'
import {
  emptyPrivilegeSet,
  normalizeRequestedPrivileges,
  normalizeSpawnPolicy,
  ROOT_CAPABILITY,
} from '../../../server/lib/spawn-policy.mjs'

function nowIso() {
  return new Date().toISOString()
}

function keyCandidates(agent = {}) {
  const keys = []
  for (const value of [
    agent.id,
    agent.fleetId,
    agent.name,
    agent.friendly_name,
    agent.friendlyName,
    agent.human ? 'human' : null,
    '*',
  ]) {
    const key = String(value || '').trim()
    if (key && !keys.includes(key)) keys.push(key)
  }
  return keys
}

function lookupRootGrant(config = {}, agent = {}) {
  const policy = config.spawnPolicy || {}
  const roots = policy.rootCeilings || policy.rootGrants || {}
  if (roots && typeof roots === 'object' && !Array.isArray(roots)) {
    for (const key of keyCandidates(agent)) {
      const configured = roots[key] ?? roots[String(key).toLowerCase()]
      if (configured != null && configured !== '') return { value: configured, configured: true }
    }
  }
  return { value: agent?.human ? ROOT_CAPABILITY : 'none', configured: false }
}

function normalizeLedgerGrant(value, fallback = 'none') {
  if (!value) {
    const policy = normalizeSpawnPolicy(fallback, 'none')
    return { spawnPolicy: policy, privilegeSet: emptyPrivilegeSet({ name: policy.name, projectedPolicy: policy }) }
  }
  const rawPrivilegeSet = value.privilegeSet || value.privileges || null
  if (rawPrivilegeSet) {
    const policy = value.spawnPolicy
      ? normalizeSpawnPolicy(value.spawnPolicy, fallback)
      : normalizeRequestedPrivileges(rawPrivilegeSet, fallback)
    const spawnPolicy = { ...policy }
    delete spawnPolicy.privilegeSet
    return { spawnPolicy, privilegeSet: withStoredSpawnDefault(rawPrivilegeSet, spawnPolicy) }
  }
  const policy = normalizeSpawnPolicy(value.spawnPolicy || value.policy || value.capability || value, fallback)
  return {
    spawnPolicy: policy,
    privilegeSet: policy.capability === 'none'
      ? emptyPrivilegeSet({ name: policy.name, projectedPolicy: policy })
      : null,
  }
}

function withStoredSpawnDefault(privilegeSet, policy) {
  if (!privilegeSet || policy.capability === 'none') return privilegeSet
  if (privilegeSet.operations?.spawn) return privilegeSet
  return {
    ...privilegeSet,
    operations: {
      ...privilegeSet.operations,
      spawn: { allow: ['**'], deny: [] },
    },
    rules: [
      ...(privilegeSet.rules || []),
      { operation: 'spawn', effect: 'allow', zone: '**', line: null },
    ],
  }
}

export class PrivilegeLedger {
  constructor(file) {
    this.file = file
    this.rows = new Map()
    this.load()
  }

  load() {
    this.rows.clear()
    if (!fs.existsSync(this.file)) return
    let parsed
    try {
      parsed = YAML.parse(fs.readFileSync(this.file, 'utf8')) || {}
    } catch (e) {
      throw new Error(`cannot read daemon privilege ledger ${this.file}: ${e.message}`)
    }
    const agents = parsed.agents && typeof parsed.agents === 'object' ? parsed.agents : {}
    for (const [id, row] of Object.entries(agents)) {
      if (!id || !row || typeof row !== 'object') continue
      const grant = normalizeLedgerGrant(row)
      this.rows.set(id, {
        id,
        spawnPolicy: grant.spawnPolicy,
        privilegeSet: grant.privilegeSet,
        updatedAt: row.updatedAt || null,
        source: row.source || 'ledger',
      })
    }
  }

  get(id) {
    const key = String(id || '').trim()
    if (!key) return null
    return this.rows.get(key) || null
  }

  grantFor(agent, config = {}) {
    const id = String(agent?.id || '').trim()
    const existing = this.get(id)
    if (existing) return existing
    const rootGrant = lookupRootGrant(config, agent)
    const root = normalizeLedgerGrant(rootGrant.value, agent?.human ? ROOT_CAPABILITY : 'none')
    const row = {
      id,
      spawnPolicy: root.spawnPolicy,
      privilegeSet: root.privilegeSet,
      updatedAt: null,
      source: rootGrant.configured || agent?.human ? 'root-config' : 'default-none',
    }
    if (id && (rootGrant.configured || agent?.human)) {
      return this.set(id, { spawnPolicy: row.spawnPolicy, privilegeSet: row.privilegeSet, source: row.source })
    }
    return row
  }

  set(id, { spawnPolicy, privilegeSet, source = 'spawn' } = {}) {
    const key = String(id || '').trim()
    if (!key) throw new Error('cannot persist daemon privilege grant without fleet id')
    const policy = normalizeSpawnPolicy(spawnPolicy, 'none')
    const row = {
      id: key,
      spawnPolicy: policy,
      privilegeSet: privilegeSet || (policy.capability === 'none'
        ? emptyPrivilegeSet({ name: policy.name, projectedPolicy: policy })
        : null),
      updatedAt: nowIso(),
      source,
    }
    this.rows.set(key, row)
    this.save()
    return row
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const agents = {}
    for (const [id, row] of [...this.rows.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      agents[id] = {
        spawnPolicy: row.spawnPolicy,
        ...(row.privilegeSet ? { privilegeSet: row.privilegeSet } : {}),
        updatedAt: row.updatedAt || nowIso(),
        source: row.source || 'ledger',
      }
    }
    const text = YAML.stringify({ version: 1, agents })
    const tmp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.${process.pid}.${Date.now()}.tmp`)
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, this.file)
  }
}

export function defaultPrivilegeLedgerPath(configDir = path.join(os.homedir(), '.config', 'tlda')) {
  return path.join(configDir, 'daemon-privileges.yaml')
}

export function createPrivilegeLedger(file = defaultPrivilegeLedgerPath()) {
  return new PrivilegeLedger(file)
}
