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

const DEFAULT_W = 300
const DEFAULT_H = 400

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

function isAlive(agent: any): boolean {
  return !agent.dead && !agent.human
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
    return <rect width={shape.props.w} height={shape.props.h} rx={8} ry={8} />
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

  // Filter and sort agents
  const aliveAgents = useMemo(() => {
    return agents
      .filter((a: any) => isAlive(a))
      .map((a: any) => {
        const ts = a.last_seen ? new Date(a.last_seen).getTime() : 0
        return { ...a, _ts: ts }
      })
      .sort((a: any, b: any) => b._ts - a._ts)
  }, [agents])

  // Sync pill shapes as children of this shape
  // Guard: only sync pills when the agent ID set actually changes
  const pillSyncRef = useRef<Set<string>>(new Set())
  const agentIdSet = useMemo(() => aliveAgents.map((a: any) => a.id).sort().join(','), [aliveAgents])
  const prevAgentIdSet = useRef('')
  useEffect(() => {
    // Skip if agent set hasn't changed (prevents create→render→create loop)
    if (agentIdSet === prevAgentIdSet.current) return
    prevAgentIdSet.current = agentIdSet
    const existingPills = editor.getCurrentPageShapes()
      .filter((s: any) => s.type === 'fleet-pill' && s.parentId === shape.id)

    const existingByKey = new Map<string, any>()
    for (const p of existingPills) {
      existingByKey.set(p.meta?.pillKey as string, p)
    }

    const wantedKeys = new Set<string>()
    const toCreate: any[] = []
    let yOffset = 32 // below header

    for (const agent of aliveAgents) {
      const key = `agent:${agent.id}`
      wantedKeys.add(key)
      const homeX = 22  // after status dot
      const homeY = yOffset + 3  // vertically centered in row

      if (!existingByKey.has(key)) {
        const color = getNickColor(agent.id, agent.is_manager)
        toCreate.push({
          id: createShapeId(),
          type: 'fleet-pill',
          parentId: shape.id,
          x: homeX,
          y: homeY,
          props: {
            w: 78,
            h: 16,
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

      // Label pills inline after agent name pill
      const labels: string[] = agent.labels || []
      let labelX = homeX + 82 // after agent name pill
      for (const label of labels) {
        const lKey = `label:${label}`
        if (!wantedKeys.has(lKey)) {
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
                w: 50,
                h: 16,
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
              },
            })
          }
          labelX += 54 // next label position
        }
      }

      yOffset += 30 // row height
    }

    // Create new pills
    if (toCreate.length > 0) {
      editor.createShapes(toCreate)
    }

    // Remove pills for dead agents
    const toDelete = existingPills
      .filter((p: any) => !wantedKeys.has(p.meta?.pillKey as string))
      .map((p: any) => p.id)
    if (toDelete.length > 0) {
      editor.deleteShapes(toDelete)
    }

    pillSyncRef.current = wantedKeys
  }, [agentIdSet, shape.id, editor])

  // Click handler — set filter on ALL fleet-chat shapes
  const handleClick = useCallback((agentId: string) => {
    // Click only selects/highlights — drag sets filter
    setSelectedId(selectedId === agentId ? null : agentId)
  }, [selectedId])

  return (
    <HTMLContainer
      style={{
        width: w,
        height: h,
        pointerEvents: 'none', // let child pill shapes receive events
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
          borderRadius: 8,
          fontSize: 11,
          overflow: 'hidden',
        }}
        onPointerDown={stopEventPropagation}
      >
        {/* Header */}
        <div style={{
          padding: '6px 10px',
          borderBottom: '1px solid rgba(128, 128, 128, 0.15)',
          fontSize: 10,
          fontWeight: 600,
          opacity: 0.6,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 12 }}>🤖</span>
          <span>agents</span>
          <span style={{ marginLeft: 'auto', fontWeight: 400, opacity: 0.5 }}>
            {aliveAgents.length} online
          </span>
        </div>

        {/* Agent rows (info only — pills handle drag) */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '2px 0' }}>
          {aliveAgents.length === 0 ? (
            <div style={{
              padding: '20px 8px',
              opacity: 0.3,
              textAlign: 'center',
              fontSize: 10,
            }}>
              No agents online
            </div>
          ) : (
            aliveAgents.map((agent: any) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                task={getTaskForAgent(agent.id)}
                isSelected={selectedId === agent.id}
                onClick={handleClick}
              />
            ))
          )}
        </div>
      </div>
    </HTMLContainer>
  )
}

function AgentRow({
  agent,
  task,
  isSelected,
  onClick,
}: {
  agent: any
  task: any
  isSelected: boolean
  onClick: (id: string) => void
}) {
  const ago = formatRelativeTime(agent._ts)
  const taskDesc = task?.title || task?.description || ''

  // Status dot: green if seen < 2min, yellow < 10min, dim otherwise
  const secsAgo = agent._ts ? (Date.now() - agent._ts) / 1000 : Infinity
  const dotColor = secsAgo < 120 ? '#4ade80' : secsAgo < 600 ? '#c8b060' : '#555'

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px',
        cursor: 'pointer',
        borderRadius: 3,
        margin: '0 2px',
        background: isSelected ? 'rgba(100, 140, 255, 0.15)' : 'transparent',
        transition: 'background 0.1s',
        height: 24,
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

      {/* Pill space — pills render here as child shapes */}
      <div style={{ width: 80 + (agent.labels?.length || 0) * 54, flexShrink: 0 }} />

      {/* Task description */}
      <div style={{
        flex: 1,
        minWidth: 0,
        fontSize: 9,
        opacity: 0.5,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {taskDesc ? taskDesc.substring(0, 50) : ''}
      </div>

      {/* Last seen */}
      <span style={{
        fontSize: 9,
        opacity: 0.35,
        flexShrink: 0,
      }}>
        {ago}
      </span>
    </div>
  )
}
