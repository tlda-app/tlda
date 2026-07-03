import fs from 'fs'
import os from 'os'
import path from 'path'
import YAML from 'yaml'
import {
  emptyPrivilegeSet,
  normalizeRequestedPrivileges,
  normalizeSpawnPolicy,
} from '../../../server/lib/spawn-policy.mjs'

function nowIso() {
  return new Date().toISOString()
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

export class PrivilegeLedgerError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'PrivilegeLedgerError'
    this.code = code
    this.reason = code
    this.detail = detail
  }
}

function normalizeDaemonConfig(parsed) {
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const privileges = root.privileges && typeof root.privileges === 'object' && !Array.isArray(root.privileges)
    ? root.privileges
    : {}
  const models = root.models && typeof root.models === 'object' && !Array.isArray(root.models)
    ? root.models
    : {}
  const agents = privileges.agents && typeof privileges.agents === 'object' && !Array.isArray(privileges.agents)
    ? privileges.agents
    : {}
  return { version: root.version || 1, privileges: { agents }, models }
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
    this.config = { version: 1, privileges: { agents: {} }, models: {} }
    this.load()
  }

  load() {
    this.rows.clear()
    this.config = { version: 1, privileges: { agents: {} }, models: {} }
    if (!fs.existsSync(this.file)) return
    let parsed
    try {
      parsed = YAML.parse(fs.readFileSync(this.file, 'utf8')) || {}
    } catch (e) {
      throw new Error(`cannot read daemon privilege ledger ${this.file}: ${e.message}`)
    }
    this.config = normalizeDaemonConfig(parsed)
    const agents = this.config.privileges.agents
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

  grantFor(agent) {
    const id = String(agent?.id || '').trim()
    const existing = this.get(id)
    if (existing) return existing
    throw new PrivilegeLedgerError(
      'SPAWN_PRIVILEGE_NO_LEDGER_ENTRY',
      `spawn refused: ${id || 'caller'} has no daemon privilege ledger entry`,
      { id: id || null },
    )
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
    this.config = {
      ...this.config,
      version: 1,
      privileges: {
        ...(this.config.privileges || {}),
        agents,
      },
    }
    const text = YAML.stringify(this.config)
    const tmp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.${process.pid}.${Date.now()}.tmp`)
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, this.file)
  }
}

export function withDaemonModelAliases(config = {}, daemonConfig = {}) {
  const models = daemonConfig?.models && typeof daemonConfig.models === 'object' && !Array.isArray(daemonConfig.models)
    ? daemonConfig.models
    : {}
  if (!Object.keys(models).length) return config || {}
  return {
    ...(config || {}),
    models,
  }
}

export function defaultPrivilegeLedgerPath(configDir = path.join(os.homedir(), '.config', 'tlda')) {
  return path.join(configDir, 'daemon-privileges.yaml')
}

export function createPrivilegeLedger(file = defaultPrivilegeLedgerPath()) {
  return new PrivilegeLedger(file)
}
