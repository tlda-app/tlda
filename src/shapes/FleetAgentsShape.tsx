/**
 * FleetAgentsShape — tldraw canvas shape showing alive fleet agents.
 *
 * Uses fleet-data.mjs (via adapter) for live SSE updates — no polling.
 * Click an agent to update filter on all fleet-chat shapes.
 * Spawns fleet-pill child shapes for agent names and labels (drag-to-filter).
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
  createShapeId,
} from 'tldraw'
import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useFleetAgents, useFleetTasks } from '../fleet-data-adapter'

const DEFAULT_W = 340
const DEFAULT_H = 400

const ROW_H = 24
const HEADER_H = 28
const PILL_H = 16
const PILL_AGENT_W = 78
const PILL_LABEL_W = 50
const PILL_X_START = 22  // after status dot column
const PILL_GAP = 4

// --- Nick color system (shared with FleetChatShape) ---
const NICK_COLORS = ['#7a9ec8', '#9370db', '#c8956a', '#6aafb0', '#b87a95', '#c8b060']
const nickMap = new Map<string, string>()
let nickIdx = 0

function getNickColor(id: string, isManager?: boolean): string {
  if (isManager) return '#7ab8a0'
  if (!id) return NICK_COLORS[0]
  if (!nickMap.has(id)) {
    nickMap.set(id, NICK_COLORS[nickIdx % NICK_COLORS.length])
    nickIdx++
  }
  return nickMap.get(id)!
}

// --- Label colors (matches dashboard hash) ---
const LABEL_COLORS = ['#9370db', '#7ab8a0', '#c8b060', '#7a9ec8', '#c8956a', '#6aafb0', '#b87a95', '#8bc87a']
function labelColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0
  return LABEL_COLORS[Math.abs(h) % LABEL_COLORS.length]
}

const STALE_THRESHOLD = 600_000  // 10 minutes

function isAlive(agent: any): boolean {
  return !agent.dead && !agent.human
}

function agentCategory(agent: any): 'alive' | 'stale' | 'dead' {
  if (agent.dead) return 'dead'
  if (agent.human) return 'dead'  // skip humans
  const ts = agent.last_seen ? new Date(agent.last_seen).getTime() : 0
  if (Date.now() - ts > STALE_THRESHOLD) return 'stale'
  return 'alive'
}

function respawnAgent(agentId: string) {
  fetch(`http://localhost:5199/api/respawn/${encodeURIComponent(agentId)}`, { method: 'POST' })
    .catch(() => {})  // fire-and-forget
}

function agentDisplayName(agent: any): string {
  return agent.friendly_name || (agent.id || '').replace('fleet:', '')
}

function formatRelativeTime(ts: number | undefined): string {
  if (!ts) return ''
  const delta = Date.now() - ts
  if (delta < 60_000) return 'now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h`
  return `${Math.floor(delta / 86400_000)}d`
}

// --- Shape definition ---

export class FleetAgentsShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-agents' as const
  static override props = {
    w: T.number,
    h: T.number,
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

  component(shape: any) {
    return <FleetAgentsComponent shape={shape} />
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={4} ry={4} />
  }
}

function FleetAgentsComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const { w, h } = shape.props

  const agents = useFleetAgents()
  const tasks = useFleetTasks()

  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Build task lookup: agent id → active task
  const activeTasks = useMemo(() => {
    return tasks.filter((t: any) => t.status === 'pending' || t.status === 'in_progress')
  }, [tasks])

  const getTaskForAgent = useCallback((agentId: string) => {
    let task = activeTasks.find((t: any) => (t.agent || t.assignee) === agentId && !t.synthetic)
    if (!task) {
      const shortId = agentId.replace(/-.*$/, '')
      task = activeTasks.find((t: any) => {
        const tid = (t.agent || t.assignee || '').replace(/-.*$/, '')
        return tid === shortId && !t.synthetic
      })
    }
    if (!task) {
      const shortId = agentId.replace(/-.*$/, '')
      task = activeTasks.find((t: any) => {
        const tid = (t.agent || t.assignee || '').replace(/-.*$/, '')
        return tid === shortId
      })
    }
    return task
  }, [activeTasks])

  // Categorize and sort agents
  const { aliveAgents, staleAgents, deadAgents } = useMemo(() => {
    const alive: any[] = []
    const stale: any[] = []
    const dead: any[] = []
    for (const a of agents) {
      if (a.human) continue
      const ts = a.last_seen ? new Date(a.last_seen).getTime() : 0
      const enriched = { ...a, _ts: ts }
      const cat = agentCategory(a)
      if (cat === 'alive') alive.push(enriched)
      else if (cat === 'stale') stale.push(enriched)
      else dead.push(enriched)
    }
    alive.sort((a: any, b: any) => b._ts - a._ts)
    stale.sort((a: any, b: any) => b._ts - a._ts)
    dead.sort((a: any, b: any) => b._ts - a._ts)
    return { aliveAgents: alive, staleAgents: stale, deadAgents: dead.slice(0, 20) }
  }, [agents])

  const [showDead, setShowDead] = useState(false)

  // Sync pill shapes as children of this shape
  // Guards: agentIdSet change triggers create/delete, width change (>10px) triggers reposition
  const pillSyncRef = useRef<Set<string>>(new Set())
  const agentIdSet = useMemo(() => aliveAgents.map((a: any) => a.id).sort().join(','), [aliveAgents])
  const prevAgentIdSet = useRef('')
  const prevW = useRef(w)
  useEffect(() => {
    const wChanged = Math.abs(w - prevW.current) > 10
    if (agentIdSet === prevAgentIdSet.current && !wChanged) return
    prevAgentIdSet.current = agentIdSet
    prevW.current = w

    const existingPills = editor.getCurrentPageShapes()
      .filter((s: any) => s.type === 'fleet-pill' && s.parentId === shape.id)

    const existingByKey = new Map<string, any>()
    for (const p of existingPills) {
      existingByKey.set(p.meta?.pillKey as string, p)
    }

    const wantedKeys = new Set<string>()
    const toCreate: any[] = []
    let yOffset = HEADER_H

    for (const agent of aliveAgents) {
      const key = `agent:${agent.id}`
      wantedKeys.add(key)
      const homeX = PILL_X_START
      const homeY = yOffset + (ROW_H - PILL_H) / 2

      if (!existingByKey.has(key)) {
        const color = getNickColor(agent.id, agent.is_manager)
        toCreate.push({
          id: createShapeId(),
          type: 'fleet-pill',
          parentId: shape.id,
          x: homeX,
          y: homeY,
          props: {
            w: PILL_AGENT_W,
            h: PILL_H,
            pillType: 'agent',
            value: agent.id,
            displayName: agentDisplayName(agent),
            color,
          },
          meta: {
            pillKey: key,
            homeX,
            homeY,
            originalParentId: shape.id,
          },
        })
      } else {
        const existing = existingByKey.get(key)!
        if (existing.meta?.homeX !== homeX || existing.meta?.homeY !== homeY) {
          editor.updateShape({
            id: existing.id,
            type: 'fleet-pill',
            x: homeX,
            y: homeY,
            meta: { ...existing.meta, homeX, homeY },
          })
        }
      }

      // Label pills after task description area
      const labels: string[] = agent.labels || []
      let labelX = Math.max(PILL_X_START + PILL_AGENT_W + PILL_GAP + 120, w * 0.65)
      const maxLabelX = w - PILL_LABEL_W - 30
      for (const label of labels) {
        if (labelX > maxLabelX) break
        const lKey = `label:${agent.id}:${label}`
        wantedKeys.add(lKey)
        const lHomeX = labelX
        const lHomeY = homeY
        if (!existingByKey.has(lKey)) {
          toCreate.push({
            id: createShapeId(),
            type: 'fleet-pill',
            parentId: shape.id,
            x: lHomeX,
            y: lHomeY,
            props: {
              w: PILL_LABEL_W,
              h: PILL_H,
              pillType: 'label',
              value: label,
              displayName: label,
              color: labelColor(label),
            },
            meta: {
              parentId: shape.id,
              pillKey: lKey,
              homeX: lHomeX,
              homeY: lHomeY,
              originalParentId: shape.id,
            },
          })
        } else {
          // Reposition existing label pill on width change
          const existing = existingByKey.get(lKey)!
          if (existing.meta?.homeX !== lHomeX) {
            editor.updateShape({
              id: existing.id,
              type: 'fleet-pill',
              x: lHomeX,
              y: lHomeY,
              meta: { ...existing.meta, homeX: lHomeX, homeY: lHomeY },
            })
          }
        }
        labelX += PILL_LABEL_W + PILL_GAP
      }

      yOffset += ROW_H
    }

    if (toCreate.length > 0) {
      editor.createShapes(toCreate)
    }

    const toDelete = existingPills
      .filter((p: any) => !wantedKeys.has(p.meta?.pillKey as string))
      .map((p: any) => p.id)
    if (toDelete.length > 0) {
      editor.deleteShapes(toDelete)
    }

    pillSyncRef.current = wantedKeys
  }, [agentIdSet, w, shape.id, editor])

  // Click handler
  const handleClick = useCallback((agentId: string) => {
    setSelectedId(selectedId === agentId ? null : agentId)
  }, [selectedId])

  return (
    <HTMLContainer
      style={{
        width: w,
        height: h,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <div
        className="fleet-shape fleet-agents-shape"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 4,
          fontSize: 9,
          overflow: 'hidden',
          fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
          position: 'relative',
        }}
        onPointerDown={stopEventPropagation}
      >
        {/* Close button */}
        <button
          className="fleet-close-btn"
          onPointerDown={stopEventPropagation}
          onPointerUp={(e) => {
            stopEventPropagation(e)
            editor.deleteShapes([shape.id])
          }}
        >
          ×
        </button>

        {/* Header row */}
        <div className="fleet-agents-header" style={{
          display: 'flex',
          alignItems: 'center',
          height: HEADER_H,
          padding: '0 8px',
          borderBottom: '1px solid rgba(128, 128, 128, 0.1)',
          fontSize: 9,
          fontWeight: 600,
          opacity: 0.4,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          flexShrink: 0,
        }}>
          <span style={{ width: 14 }} />
          <span style={{ width: PILL_AGENT_W + PILL_GAP }}>Agent</span>
          <span style={{ flex: 1 }}>Task</span>
          <span style={{ width: 50, textAlign: 'right' }}>Labels</span>
          <span style={{ width: 30, textAlign: 'right' }}>Seen</span>
        </div>

        {/* Agent rows — scrollable */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
          {/* Alive section */}
          {aliveAgents.length === 0 && staleAgents.length === 0 && deadAgents.length === 0 ? (
            <div style={{
              padding: '20px 8px',
              opacity: 0.2,
              textAlign: 'center',
              fontSize: 9,
            }}>
              No agents
            </div>
          ) : (
            <>
              {aliveAgents.map((agent: any) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  task={getTaskForAgent(agent.id)}
                  isSelected={selectedId === agent.id}
                  onClick={handleClick}
                />
              ))}

              {/* Stale section */}
              {staleAgents.length > 0 && (
                <>
                  <SectionHeader label="stale" count={staleAgents.length} />
                  {staleAgents.map((agent: any) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      task={getTaskForAgent(agent.id)}
                      isSelected={selectedId === agent.id}
                      onClick={handleClick}
                      dimmed
                      showRespawn
                    />
                  ))}
                </>
              )}

              {/* Dead section — collapsed by default */}
              {deadAgents.length > 0 && (
                <>
                  <SectionHeader
                    label="dead"
                    count={deadAgents.length}
                    collapsed={!showDead}
                    onToggle={() => setShowDead(!showDead)}
                  />
                  {showDead && deadAgents.map((agent: any) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      task={getTaskForAgent(agent.id)}
                      isSelected={selectedId === agent.id}
                      onClick={handleClick}
                      dimmed
                      showRespawn
                    />
                  ))}
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          height: 20,
          padding: '0 8px',
          display: 'flex',
          alignItems: 'center',
          borderTop: '1px solid rgba(128, 128, 128, 0.08)',
          fontSize: 9,
          opacity: 0.25,
          flexShrink: 0,
        }}>
          {aliveAgents.length} online
          {staleAgents.length > 0 && <span style={{ marginLeft: 6 }}>· {staleAgents.length} stale</span>}
        </div>
      </div>
    </HTMLContainer>
  )
}

function SectionHeader({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string
  count: number
  collapsed?: boolean
  onToggle?: () => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        fontSize: 8,
        fontWeight: 600,
        opacity: 0.3,
        letterSpacing: '0.5px',
        textTransform: 'uppercase',
        borderTop: '1px solid rgba(128, 128, 128, 0.06)',
        marginTop: 2,
        cursor: onToggle ? 'pointer' : 'default',
        userSelect: 'none',
      }}
      onPointerDown={(e) => stopEventPropagation(e)}
      onPointerUp={(e) => {
        stopEventPropagation(e)
        onToggle?.()
      }}
    >
      {onToggle && <span style={{ fontSize: 7 }}>{collapsed ? '▸' : '▾'}</span>}
      <span>{label}</span>
      <span style={{ opacity: 0.6 }}>({count})</span>
    </div>
  )
}

function AgentRow({
  agent,
  task,
  isSelected,
  onClick,
  dimmed,
  showRespawn,
}: {
  agent: any
  task: any
  isSelected: boolean
  onClick: (id: string) => void
  dimmed?: boolean
  showRespawn?: boolean
}) {
  const ago = formatRelativeTime(agent._ts)
  const taskDesc = task?.title || task?.description || ''
  const name = agentDisplayName(agent)
  const color = getNickColor(agent.id, agent.is_manager)

  // Status dot: green if seen < 2min, yellow < 10min, dim otherwise
  const secsAgo = agent._ts ? (Date.now() - agent._ts) / 1000 : Infinity
  const dotColor = agent.dead
    ? 'rgba(128,128,128,0.15)'
    : secsAgo < 120 ? '#4ade80' : secsAgo < 600 ? '#c8b060' : 'rgba(128,128,128,0.3)'

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '0 8px',
        cursor: 'pointer',
        height: ROW_H,
        background: isSelected ? 'rgba(100, 140, 255, 0.08)' : 'transparent',
        transition: 'background 0.1s',
        opacity: dimmed ? 0.4 : 1,
      }}
      onPointerDown={(e) => {
        stopEventPropagation(e)
      }}
      onPointerUp={(e) => {
        stopEventPropagation(e)
        onClick(agent.id)
      }}
    >
      {/* Status dot */}
      <div style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: dotColor,
        flexShrink: 0,
      }} />

      {/* Agent name — for alive agents, pills render here as child shapes.
          For stale/dead, render inline text since they don't get pills. */}
      {dimmed ? (
        <div style={{
          width: PILL_AGENT_W + PILL_GAP,
          flexShrink: 0,
          fontSize: 9,
          fontWeight: 500,
          color,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {name}
        </div>
      ) : (
        <div style={{ width: PILL_AGENT_W + PILL_GAP, flexShrink: 0 }} />
      )}

      {/* Task description */}
      <div style={{
        flex: 1,
        minWidth: 0,
        fontSize: 9,
        opacity: 0.4,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {taskDesc ? taskDesc.substring(0, 40) : ''}
      </div>

      {/* Respawn button or label pill space */}
      {showRespawn ? (
        <button
          style={{
            background: 'none',
            border: '1px solid rgba(128,128,128,0.2)',
            borderRadius: 3,
            color: 'rgba(128,128,128,0.5)',
            fontSize: 10,
            padding: '0 4px',
            cursor: 'pointer',
            lineHeight: '16px',
            flexShrink: 0,
          }}
          title="Respawn agent"
          onPointerDown={(e) => stopEventPropagation(e)}
          onPointerUp={(e) => {
            stopEventPropagation(e)
            respawnAgent(agent.id)
          }}
        >
          ↻
        </button>
      ) : (
        <div style={{
          width: (agent.labels?.length || 0) * (PILL_LABEL_W + PILL_GAP),
          flexShrink: 0,
        }} />
      )}

      {/* Last seen */}
      <span style={{
        fontSize: 9,
        opacity: 0.25,
        flexShrink: 0,
        width: 24,
        textAlign: 'right',
      }}>
        {ago}
      </span>
    </div>
  )
}
