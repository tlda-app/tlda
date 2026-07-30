import {
  ACTIVITY_HEALTH_BOUNDARIES,
  activityHealthForProjection,
  formatActivityHealthAge,
  activityHealthLastKnownGoodAgeMs,
  isActivityHealthOk,
} from '../../shared/activity-health.mjs'
// @ts-ignore - vanilla JS module
import { fleetRosterCategory } from '../../shared/fleet-runtime-status.mjs'
// @ts-ignore - vanilla JS module
import { pretty_name_plain_text } from '../../shared/pretty_name.mjs'

const NICK_COLORS = ['#7a9ec8', '#9370db', '#c8956a', '#6aafb0', '#b87a95', '#c8b060']
const nickMap = new Map<string, string>()
let nickIdx = 0

export function getFleetAgentNickColor(id: string, isManager?: boolean): string {
  if (isManager) return '#7ab8a0'
  if (!id) return NICK_COLORS[0]
  if (!nickMap.has(id)) {
    nickMap.set(id, NICK_COLORS[nickIdx % NICK_COLORS.length])
    nickIdx++
  }
  return nickMap.get(id)!
}

const LABEL_COLORS = ['#9370db', '#7ab8a0', '#c8b060', '#7a9ec8', '#c8956a', '#6aafb0', '#b87a95', '#8bc87a']

export function fleetAgentLabelColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0
  return LABEL_COLORS[Math.abs(h) % LABEL_COLORS.length]
}

export function fleetAgentCategory(agent: any): 'awake' | 'hibernating' {
  const category = fleetRosterCategory(agent)
  return category === 'awake' ? 'awake' : 'hibernating'
}

type SpawnModelCatalogEntry = {
  alias?: string
  id?: string
  description?: string
}

type FleetAgentDirectoryFormatOptions = {
  spawnModels?: SpawnModelCatalogEntry[]
}

function readableToken(value: string): string {
  return value.replace(/[_-]+/g, ' ').trim()
}

function readablePath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const parts = trimmed.split('/').filter(Boolean)
  return parts[parts.length - 1] || trimmed
}

export function formatFleetAgentModel(model: string | null | undefined, options: FleetAgentDirectoryFormatOptions = {}): string {
  if (!model) return ''
  const catalog = options.spawnModels || []
  const match = catalog.find((entry) => entry.alias === model || entry.id === model)
  if (match) return match.description || match.alias || model
  let s = model.includes('/') ? model.split('/').pop()! : model
  s = s.replace(/^claude-/, '')
  return s.replace(/[.\-]/g, '')
}

export function formatFleetAgentPermission(meta: any): string {
  const grant = meta?.permissionGrant
  if (typeof grant === 'string') return grant
  if (grant?.type === 'permission-intersection' && Array.isArray(grant.profiles)) {
    return grant.profiles.join(' intersection ')
  }
  return ''
}

export function formatFleetAgentEffort(effort: string | null | undefined, _kind?: string | null): string {
  if (!effort) return ''
  return `${effort} effort`
}

function modelOptionsOf(meta: any): Record<string, string> {
  const source = meta?.modelOptions && typeof meta.modelOptions === 'object' && !Array.isArray(meta.modelOptions)
    ? meta.modelOptions
    : {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value != null && value !== '') out[key] = String(value)
  }
  if (meta?.effort && !out.effort) out.effort = String(meta.effort)
  return out
}

export function formatFleetAgentSpawnOptions(meta: any): string[] {
  return Object.entries(modelOptionsOf(meta))
    .sort(([a], [b]) => (a === 'effort' ? -1 : b === 'effort' ? 1 : a.localeCompare(b)))
    .map(([key, value]) => key === 'effort'
      ? `${readableToken(value)} effort`
      : `${readableToken(key)}: ${readableToken(value)}`)
}

export function formatFleetAgentRelativeTime(ts: number | undefined): string {
  if (!ts) return ''
  const delta = Date.now() - ts
  if (delta < 60_000) return 'now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h`
  return `${Math.floor(delta / 86400_000)}d`
}

export function formatFleetAgentUserActivityHealth(health: any): string {
  if (!health || isActivityHealthOk(health)) return ''
  if (health.boundary === ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX) return ''
  const age = formatActivityHealthAge(activityHealthLastKnownGoodAgeMs(health))
  return `activity unavailable:${age}`
}

export function formatFleetAgentActivityHealth(meta: any): string {
  return formatFleetAgentUserActivityHealth(activityHealthForProjection(meta || {}))
}

export function formatFleetAgentActivityHealthForAgent(agent: any): string {
  if (agent?.human) return ''
  return formatFleetAgentUserActivityHealth(activityHealthForProjection(agent?.metadata || {}))
}

export function fleetAgentDisplayLabel(agent: any): string {
  if (!agent) return '[unknown]'
  return (pretty_name_plain_text(agent.pretty_name ?? agent.friendly_name) || agent.id || '').replace(/^fleet:/, '')
}

export function fleetAgentExactName(agent: any): string {
  if (!agent) return ''
  return agent.friendly_name || agent.id || ''
}

export function fleetAgentVisibleName(agent: any): string {
  if (!agent?.parent_agent_id) return agent?.pretty_name ?? agent?.friendly_name ?? agent?.id ?? ''
  const exactName = fleetAgentExactName(agent)
  const childName = exactName.slice(exactName.lastIndexOf(':') + 1)
  return `:${childName}`
}

function agentTimestamp(agent: any): number {
  if (typeof agent._ts === 'number') return agent._ts
  const raw = agent.last_active || agent.last_seen || agent.registered_at
  const parsed = raw ? new Date(raw).getTime() : 0
  return Number.isFinite(parsed) ? parsed : 0
}

export type FleetAgentDirectoryRowModel = {
  agent: any
  id: string
  exactName: string
  displayName: string
  prettyName: string
  color: string
  labels: string[]
  lastActiveAt: number
  ago: string
  dimmed: boolean
  nameOpacity: number
  machine: string
  project: string
  cwd: string
  cwdLabel: string
  model: string
  spawnOptions: string[]
  permission: string
  activityHealth: string
  hoverTitle: string
}

export function toFleetAgentDirectoryRow(agent: any, options: FleetAgentDirectoryFormatOptions = {}): FleetAgentDirectoryRowModel {
  const id = agent?.id || ''
  const exactName = fleetAgentExactName(agent)
  const displayName = fleetAgentDisplayLabel(agent)
  const ts = agentTimestamp(agent)
  const meta = agent?.metadata || {}
  const ago = formatFleetAgentRelativeTime(ts)
  const machine = agent?.machine_id || ''
  const project = String(meta.project || meta.doc || agent?.project || '').trim()
  const cwd = String(meta.cwd || agent?.cwd || '').trim()
  const cwdLabel = readablePath(cwd)
  const model = formatFleetAgentModel(meta.model, options)
  const spawnOptions = formatFleetAgentSpawnOptions(meta)
  const permission = formatFleetAgentPermission(meta)
  const activityHealth = formatFleetAgentActivityHealthForAgent(agent)
  const secsAgo = ts ? (Date.now() - ts) / 1000 : Infinity
  const nameOpacity = secsAgo < 120 ? 1.0 : secsAgo < 600 ? 0.85 : 0.65
  const folderTitle = project ? `project:${project}` : cwd ? `cwd:${cwd}` : ''
  const hoverTitle = [displayName, machine && `machine: ${machine}`, folderTitle, model && `model: ${model}`, spawnOptions.length && spawnOptions.join(' · '), activityHealth && `activity ${activityHealth}`, ago && `seen ${ago}`]
    .filter(Boolean)
    .join('  ·  ')
  return {
    agent,
    id,
    exactName,
    displayName,
    prettyName: fleetAgentVisibleName(agent),
    color: getFleetAgentNickColor(id, agent?.is_manager),
    labels: Array.isArray(agent?.labels) ? agent.labels : [],
    lastActiveAt: ts,
    ago,
    dimmed: fleetAgentCategory(agent) === 'hibernating',
    nameOpacity,
    machine,
    project,
    cwd,
    cwdLabel,
    model,
    spawnOptions,
    permission,
    activityHealth,
    hoverTitle,
  }
}

export function getFleetAgentDirectoryRows(agents: any[], options: FleetAgentDirectoryFormatOptions = {}): FleetAgentDirectoryRowModel[] {
  return agents
    .filter((agent) => !agent.dead)
    .map((agent) => toFleetAgentDirectoryRow(agent, options))
    .filter((row) => !!row.exactName)
}

export function sortFleetAgentDirectoryRows(rows: FleetAgentDirectoryRowModel[]): FleetAgentDirectoryRowModel[] {
  return [...rows].sort((a, b) => a.displayName.localeCompare(b.displayName))
}

export function sortFleetAgentDirectoryRowsByRecency(rows: FleetAgentDirectoryRowModel[]): FleetAgentDirectoryRowModel[] {
  return [...rows].sort((a, b) =>
    b.lastActiveAt - a.lastActiveAt || a.displayName.localeCompare(b.displayName)
  )
}

export type FleetAgentDirectoryFolding = {
  visibleAgents: any[]
  childCounts: Map<string, number>
  foldedParentIds: Set<string>
}

export function projectFleetAgentDirectoryFolding(
  agents: any[],
  overrides: Record<string, boolean> = {},
): FleetAgentDirectoryFolding {
  const byId = new Map(agents.map(agent => [agent.id, agent]))
  const childrenByParent = new Map<string, any[]>()
  for (const agent of agents) {
    if (!agent?.parent_agent_id || !byId.has(agent.parent_agent_id)) continue
    const children = childrenByParent.get(agent.parent_agent_id) || []
    children.push(agent)
    childrenByParent.set(agent.parent_agent_id, children)
  }

  const descendants = (parentId: string): any[] => {
    const out: any[] = []
    const seen = new Set<string>([parentId])
    const visit = (id: string) => {
      for (const child of childrenByParent.get(id) || []) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        out.push(child)
        visit(child.id)
      }
    }
    visit(parentId)
    return out
  }

  const childCounts = new Map<string, number>()
  const foldedParentIds = new Set<string>()
  for (const parentId of childrenByParent.keys()) {
    const familyChildren = descendants(parentId)
    childCounts.set(parentId, familyChildren.length)
    const folded = Object.prototype.hasOwnProperty.call(overrides, parentId)
      ? overrides[parentId]
      : familyChildren.every(child => fleetAgentCategory(child) === 'hibernating')
    if (folded) foldedParentIds.add(parentId)
  }

  const visibleAgents = agents.filter(agent => {
    let parentId = agent?.parent_agent_id
    const seen = new Set<string>()
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      if (foldedParentIds.has(parentId)) return false
      seen.add(parentId)
      parentId = byId.get(parentId)?.parent_agent_id
    }
    return true
  })

  return { visibleAgents, childCounts, foldedParentIds }
}
