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

export function formatFleetAgentModel(model: string | null | undefined): string {
  if (!model) return ''
  let s = model.includes('/') ? model.split('/').pop()! : model
  s = s.replace(/^claude-/, '')
  return s.replace(/[.\-]/g, '')
}

const PERMISSION_LABELS: Record<string, string> = {
  read: 'read',
  write: 'write',
  'tlda-write': 'tlda-write',
  full: 'full',
}
const POLICY_LABELS: Record<string, string> = {
  cwd: 'own project',
  'tlda-projects': 'all projects',
  unsandboxed: 'machine',
}

export function formatFleetAgentPermission(meta: any): string {
  const sp = meta?.spawnPolicy
  if (!sp) return ''
  const cap = typeof sp === 'string' ? sp : sp.permission
  const policy = typeof sp === 'object' ? sp.policy : null
  if (!cap) return ''
  const capLabel = PERMISSION_LABELS[cap] || cap
  const policyLabel = policy ? (POLICY_LABELS[policy] || policy) : ''
  return policyLabel ? `${capLabel} · ${policyLabel}` : capLabel
}

export function formatFleetAgentEffort(effort: string | null | undefined, kind: string | null | undefined): string {
  if (!effort || kind !== 'claude') return ''
  return `${effort} effort`
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
  return formatFleetAgentUserActivityHealth(activityHealthForProjection(agent?.metadata || {}, agent?.runtime_status || null, {
    allowRoutableNoTmuxSuppression: true,
  }))
}

export function fleetAgentDisplayLabel(agent: any): string {
  if (!agent) return '[unknown]'
  return (pretty_name_plain_text(agent.pretty_name ?? agent.friendly_name) || agent.id || '').replace(/^fleet:/, '')
}

export function fleetAgentExactName(agent: any): string {
  if (!agent) return ''
  return agent.friendly_name || (agent.id || '').replace('fleet:', '')
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
  model: string
  effort: string
  permission: string
  activityHealth: string
  notResumable: boolean
  resumableStatus: string
  hoverTitle: string
}

export function toFleetAgentDirectoryRow(agent: any): FleetAgentDirectoryRowModel {
  const id = agent?.id || ''
  const exactName = fleetAgentExactName(agent)
  const displayName = fleetAgentDisplayLabel(agent)
  const ts = agentTimestamp(agent)
  const meta = agent?.metadata || {}
  const ago = formatFleetAgentRelativeTime(ts)
  const machine = agent?.machine_id || ''
  const model = formatFleetAgentModel(meta.model)
  const effort = formatFleetAgentEffort(meta.effort, meta.kind)
  const permission = formatFleetAgentPermission(meta)
  const activityHealth = formatFleetAgentActivityHealthForAgent(agent)
  const notResumable = !agent?.human && !agent?.dead && (!agent?.session_id || !agent?.resume_id)
  const resumableStatus = notResumable ? 'starting · not resumable yet' : ''
  const secsAgo = ts ? (Date.now() - ts) / 1000 : Infinity
  const nameOpacity = secsAgo < 120 ? 1.0 : secsAgo < 600 ? 0.85 : 0.65
  const hoverTitle = [displayName, resumableStatus, machine && `machine: ${machine}`, model && `model: ${model}`, activityHealth && `activity ${activityHealth}`, ago && `seen ${ago}`]
    .filter(Boolean)
    .join('  ·  ')
  return {
    agent,
    id,
    exactName,
    displayName,
    prettyName: agent?.pretty_name ?? agent?.friendly_name ?? displayName,
    color: getFleetAgentNickColor(id, agent?.is_manager),
    labels: Array.isArray(agent?.labels) ? agent.labels : [],
    lastActiveAt: ts,
    ago,
    dimmed: fleetAgentCategory(agent) === 'hibernating',
    nameOpacity,
    machine,
    model,
    effort,
    permission,
    activityHealth,
    notResumable,
    resumableStatus,
    hoverTitle,
  }
}

export function getFleetAgentDirectoryRows(agents: any[]): FleetAgentDirectoryRowModel[] {
  return agents
    .filter((agent) => !agent.dead)
    .map((agent) => toFleetAgentDirectoryRow(agent))
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
