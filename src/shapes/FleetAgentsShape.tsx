/**
 * FleetAgentsShape — tldraw canvas shape showing alive fleet agents.
 *
 * Uses fleet-data.mjs (via adapter) for live SSE updates — no polling.
 * Click an agent to update filter on all fleet-chat shapes.
 * Drag an agent to set a specific chat shape's filter.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
} from 'tldraw'
import { useState, useCallback, useMemo } from 'react'
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
  // Task.agent uses short IDs (fleet:96bd8018), agents use full IDs (fleet:96bd-mn9dedp4)
  // Match by extracting the hex prefix after "fleet:" (before the dash)
  const activeTasks = useMemo(() => {
    return tasks.filter((t: any) => t.status === 'pending' || t.status === 'in_progress')
  }, [tasks])

  const getTaskForAgent = useCallback((agentId: string) => {
    // Try exact match first
    let task = activeTasks.find((t: any) => (t.agent || t.assignee) === agentId && !t.synthetic)
    if (!task) {
      // Try prefix match: fleet:96bd8018 matches fleet:96bd-mn9dedp4
      const shortId = agentId.replace(/-.*$/, '') // fleet:96bd-mn9dedp4 → fleet:96bd
      task = activeTasks.find((t: any) => {
        const tid = (t.agent || t.assignee || '').replace(/-.*$/, '')
        return tid === shortId && !t.synthetic
      })
    }
    if (!task) {
      // Try synthetic
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
      .sort((a: any, b: any) => b._ts - a._ts) // most recent first
  }, [agents])

  // Click handler — set filter on ALL fleet-chat shapes
  const handleClick = useCallback((agentId: string) => {
    const newId = selectedId === agentId ? null : agentId
    setSelectedId(newId)
    const allShapes = editor.getCurrentPageShapes()
    for (const s of allShapes) {
      if (s.type === 'fleet-chat') {
        editor.updateShape({
          id: s.id,
          type: 'fleet-chat',
          props: { ...(s as any).props, filter: newId || '' },
        })
      }
    }
  }, [editor, selectedId])

  // Drag handler — set dataTransfer for drop on specific chat shapes
  const handleDragStart = useCallback((e: React.DragEvent, agent: any) => {
    e.dataTransfer.setData('application/x-chat-attachment', agent.id)
    e.dataTransfer.setData('text/plain', agentDisplayName(agent))
    e.dataTransfer.effectAllowed = 'link'
  }, [])

  return (
    <HTMLContainer
      style={{
        width: w,
        height: h,
        pointerEvents: 'all',
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
          backgroundColor: '#0f0f1a',
          border: '1px solid rgba(128, 128, 128, 0.2)',
          borderRadius: 8,
          fontSize: 11,
          color: '#c8d0e0',
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

        {/* Agent table */}
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
                onDragStart={handleDragStart}
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
  onDragDrop,
  editor,
}: {
  agent: any
  task: any
  isSelected: boolean
  onClick: (id: string) => void
  onDragDrop: (agentId: string, targetShapeId: string) => void
  editor: any
}) {
  const name = agentDisplayName(agent)
  const nickColor = getNickColor(agent.id, agent.is_manager)
  const ago = formatRelativeTime(agent._ts)
  const labels: string[] = agent.labels || []
  const taskDesc = task?.title || task?.description || ''

  // Status dot: green if seen < 2min, yellow < 10min, dim otherwise
  const secsAgo = agent._ts ? (Date.now() - agent._ts) / 1000 : Infinity
  const dotColor = secsAgo < 120 ? '#4ade80' : secsAgo < 600 ? '#c8b060' : '#555'

  const dragState = useRef<{ started: boolean; ghost: HTMLElement | null; startX: number; startY: number }>({ started: false, ghost: null, startX: 0, startY: 0 })

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        cursor: 'pointer',
        borderRadius: 3,
        margin: '0 2px',
        background: isSelected ? 'rgba(100, 140, 255, 0.15)' : 'transparent',
        transition: 'background 0.1s',
      }}
      onPointerDown={(e) => {
        stopEventPropagation(e)
        // Track for potential drag
        dragState.current = { started: false, ghost: null, startX: e.clientX, startY: e.clientY }
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        stopEventPropagation(e)
        const ds = dragState.current
        if (!ds.startX && !ds.startY) return
        const dx = e.clientX - ds.startX
        const dy = e.clientY - ds.startY
        if (!ds.started && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
          ds.started = true
          ds.ghost = document.createElement('div')
          ds.ghost.textContent = name
          ds.ghost.style.cssText = `position:fixed;z-index:10000;pointer-events:none;font-size:11px;padding:2px 8px;border-radius:4px;color:${nickColor};border:1px solid ${nickColor};background:${nickColor}20;opacity:0.9;white-space:nowrap;`
          document.body.appendChild(ds.ghost)
        }
        if (ds.ghost) {
          ds.ghost.style.left = e.clientX + 8 + 'px'
          ds.ghost.style.top = e.clientY - 10 + 'px'
        }
      }}
      onPointerUp={(e) => {
        stopEventPropagation(e)
        const ds = dragState.current
        if (ds.ghost) {
          ds.ghost.remove()
          // Find fleet-chat shape under the pointer
          const point = editor.screenToPage({ x: e.clientX, y: e.clientY })
          const hitShape = editor.getShapeAtPoint(point, { hitInside: true, margin: 0 })
          if (hitShape && hitShape.type === 'fleet-chat') {
            onDragDrop(agent.id, hitShape.id)
          }
        } else if (!ds.started) {
          // Simple click — no drag happened
          onClick(agent.id)
        }
        dragState.current = { started: false, ghost: null, startX: 0, startY: 0 }
      }}
    >
      {/* Avatar circle with nick color */}
      <div style={{
        width: 22,
        height: 22,
        borderRadius: '50%',
        background: `${nickColor}25`,
        border: `1.5px solid ${nickColor}50`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        fontWeight: 700,
        color: nickColor,
        flexShrink: 0,
        textTransform: 'uppercase',
        position: 'relative',
      }}>
        {name.charAt(0)}
        {/* Status dot */}
        <div style={{
          position: 'absolute',
          bottom: -1,
          right: -1,
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: dotColor,
          border: '1.5px solid #0f0f1a',
        }} />
      </div>

      {/* Name + task column */}
      <div style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}>
          <span style={{ fontWeight: 600, fontSize: 11, color: nickColor }}>{name}</span>
          {agent.is_manager && (
            <span style={{
              fontSize: 8,
              padding: '0 3px',
              borderRadius: 2,
              background: 'rgba(122, 184, 160, 0.2)',
              color: '#7ab8a0',
            }}>mgr</span>
          )}
          {/* Label pills */}
          {labels.map((l: string) => (
            <span key={l} style={{
              fontSize: 8,
              padding: '0 4px',
              borderRadius: 3,
              background: `${labelColor(l)}20`,
              color: labelColor(l),
              whiteSpace: 'nowrap',
            }}>{l}</span>
          ))}
        </div>
        {taskDesc && (
          <span style={{
            fontSize: 9,
            opacity: 0.5,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {taskDesc.substring(0, 50)}
          </span>
        )}
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
