/**
 * FleetAgentsShape — tldraw canvas shape showing fleet agents as a clean HTML table.
 *
 * Uses fleet-data.mjs (via adapter) for live SSE updates — no polling.
 * Agent names and label chips are draggable — on pointerdown, an ephemeral
 * fleet-pill shape is created and follows the pointer. Dropping on a
 * fleet-chat updates its filter; dropping on empty canvas creates a new chat.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
  createShapeId,
} from 'tldraw'
import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useFleetAgents, useFleetTasks } from '../fleet-data-adapter'
import { dropPillOnTarget, computeDropSlot, dropGhostState, dropGhostBus } from './FleetPillShape'


const DEFAULT_W = 340
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

const STALE_THRESHOLD = 600_000  // 10 minutes

function agentCategory(agent: any): 'alive' | 'stale' | 'dead' {
  if (agent.dead) return 'dead'
  if (agent.human) return 'dead'
  const ts = agent.last_seen ? new Date(agent.last_seen).getTime() : 0
  if (Date.now() - ts > STALE_THRESHOLD) return 'stale'
  return 'alive'
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

  indicator() {
    return null
  }
}

// --- Drag-to-create-pill handler ---

interface DragState {
  pillId: string | null
  pillType: 'agent' | 'label'
  value: string
  displayName: string
  color: string
  startX: number
  startY: number
  started: boolean
}

const DRAG_THRESHOLD = 5

function usePillDrag() {
  const editor = useEditor()
  const dragRef = useRef<DragState | null>(null)

  // Always-on document capture listeners so they're registered before any
  // dynamic listeners (including tldraw's own per-drag listeners). When no
  // drag is active the null-check exits immediately — zero overhead.
  // Pill stays in the HUD editor throughout; screenToPage uses HUD coords,
  // which share the same camera as the main canvas. dropPillOnTarget routes
  // shape creation to the main editor via __tldraw_editor__.
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const drag = dragRef.current
      if (!drag) return
      e.stopImmediatePropagation()
      e.preventDefault()

      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY

      if (!drag.started) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
        drag.started = true

        const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
        const measureEl = document.createElement('span')
        measureEl.style.cssText = "position:absolute;visibility:hidden;font:500 9px 'SF Mono',Menlo,Consolas,monospace;white-space:nowrap;padding:1px 6px;border:1px solid transparent"
        measureEl.textContent = drag.displayName
        document.body.appendChild(measureEl)
        const pw = measureEl.offsetWidth
        const ph = measureEl.offsetHeight
        document.body.removeChild(measureEl)
        const pillId = createShapeId()
        editor.createShape({
          id: pillId,
          type: 'fleet-pill' as any,
          x: pagePos.x - pw / 2,
          y: pagePos.y - ph / 2,
          props: { w: pw, h: ph, pillType: drag.pillType, value: drag.value, displayName: drag.displayName, color: drag.color },
        })
        drag.pillId = pillId as unknown as string
        // Reset tldraw's state machine — it saw our pointerdown but will never see pointerup
        // (we stopImmediatePropagation those). editor.cancel() resets it without cancelling
        // the real pointer stream (unlike dispatching a DOM pointercancel, which stops all
        // further real pointer events for this pointerId and leaves the pill stuck).
        editor.cancel()
        return
      }

      if (drag.pillId) {
        const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
        const pillShape = editor.getShape(drag.pillId as any) as any
        const pw = pillShape?.props?.w || 70
        const ph = pillShape?.props?.h || 18
        editor.updateShape({
          id: drag.pillId as any,
          type: 'fleet-pill' as any,
          x: pagePos.x - pw / 2,
          y: pagePos.y - ph / 2,
        })
        // Publish slot for ghost preview (uses main editor for page coords)
        const mainEditor = (window as any).__tldraw_editor__
        const targetEditor = mainEditor || editor
        dropGhostState.slot = computeDropSlot(targetEditor, null, pagePos.x, pagePos.y)
        dropGhostBus.dispatchEvent(new CustomEvent('change'))
      }
    }

    function onUp(e: PointerEvent) {
      const drag = dragRef.current
      if (!drag) return
      e.stopImmediatePropagation()
      dragRef.current = null

      if (!drag.started || !drag.pillId) return

      // Clear ghost before drop
      dropGhostState.slot = null
      dropGhostBus.dispatchEvent(new CustomEvent('change'))

      const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
      dropPillOnTarget(editor, drag.pillId as any, drag.value, pagePos)
      try { editor.deleteShapes([drag.pillId as any]) } catch {}
    }

    document.addEventListener('pointermove', onMove, { capture: true })
    document.addEventListener('pointerup', onUp, { capture: true })
    return () => {
      document.removeEventListener('pointermove', onMove, { capture: true })
      document.removeEventListener('pointerup', onUp, { capture: true })
    }
  }, [editor])

  const startDrag = useCallback((
    e: React.PointerEvent,
    pillType: 'agent' | 'label',
    value: string,
    displayName: string,
    color: string,
  ) => {
    stopEventPropagation(e)
    e.preventDefault()
    dragRef.current = {
      pillId: null, pillType, value, displayName, color,
      startX: e.clientX, startY: e.clientY, started: false,
    }
  }, [])

  return { startDrag }
}


function FleetAgentsComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const { w, h } = shape.props
  const agents = useFleetAgents()
  const tasks = useFleetTasks()
  const { startDrag } = usePillDrag()

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
  const { aliveAgents, staleAgents } = useMemo(() => {
    const alive: any[] = []
    const stale: any[] = []
    for (const a of agents) {
      if (a.human) continue
      const ts = a.last_seen ? new Date(a.last_seen).getTime() : 0
      const enriched = { ...a, _ts: ts }
      const cat = agentCategory(a)
      if (cat === 'alive') alive.push(enriched)
      else if (cat === 'stale') stale.push(enriched)
      // dead agents not shown
    }
    alive.sort((a: any, b: any) => b._ts - a._ts)
    stale.sort((a: any, b: any) => b._ts - a._ts)
    return { aliveAgents: alive, staleAgents: stale }
  }, [agents])

  const [showStale, setShowStale] = useState(false)

  // Clean up any permanent pill shapes that were children of this panel (legacy)
  const cleanedRef = useRef(false)
  if (!cleanedRef.current) {
    cleanedRef.current = true
    const orphanPills = editor.getCurrentPageShapes()
      .filter((s: any) => s.type === 'fleet-pill' && s.parentId === shape.id)
    if (orphanPills.length > 0) {
      editor.deleteShapes(orphanPills.map((s: any) => s.id))
    }
  }

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
          borderRadius: 0,
          fontSize: 9,
          overflow: 'hidden',
          fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
          position: 'relative',
        }}
      >
        {/* Close + layout buttons */}
        <div className="fleet-btn-group" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="fleet-close-btn"
            onPointerUp={(e) => {
              e.stopPropagation()
              editor.deleteShapes([shape.id])
            }}
          >
            ×
          </button>
          <button
            className="fleet-layout-btn"
            onPointerUp={(e) => {
              e.stopPropagation()
              editor.select(shape.id)
            }}
            title="Resize / move"
          >
            ⊞
          </button>
        </div>

        {/* Header */}
        <div
          className="fleet-agents-header"
        >
          <span className="fleet-agents-col-name">Agent</span>
          <span className="fleet-agents-col-seen">Seen</span>
          <span className="fleet-agents-col-task">Task</span>
          <span className="fleet-agents-col-labels">Labels</span>
        </div>

        {/* Agent rows — scrollable */}
        <div className="fleet-agents-body">
          {aliveAgents.length === 0 && staleAgents.length === 0 ? (
            <div className="fleet-agents-empty">No agents</div>
          ) : (
            <>
              {aliveAgents.map((agent: any) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  task={getTaskForAgent(agent.id)}
                  onStartDrag={startDrag}
                />
              ))}

              {staleAgents.length > 0 && (
                <>
                  <div
                    className="fleet-agents-section-header"
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => {
                      e.stopPropagation()
                      setShowStale(!showStale)
                    }}
                  >
                    <span className="fleet-agents-section-toggle">
                      {showStale ? '▾' : '▸'}
                    </span>
                    <span>stale</span>
                    <span className="fleet-agents-section-count">({staleAgents.length})</span>
                  </div>
                  {showStale && staleAgents.map((agent: any) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      task={getTaskForAgent(agent.id)}
                      dimmed
                      onStartDrag={startDrag}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="fleet-agents-footer">
          {aliveAgents.length} online
          {staleAgents.length > 0 && <span style={{ marginLeft: 6 }}>· {staleAgents.length} stale</span>}
        </div>
      </div>
    </HTMLContainer>
  )
}

function AgentRow({
  agent,
  task,
  dimmed,
  onStartDrag,
}: {
  agent: any
  task: any
  dimmed?: boolean
  onStartDrag: (e: React.PointerEvent, pillType: 'agent' | 'label', value: string, displayName: string, color: string) => void
}) {
  const taskDesc = task?.title || task?.description || ''
  const name = agentDisplayName(agent)
  const color = getNickColor(agent.id, agent.is_manager)
  const labels: string[] = agent.labels || []
  const ago = formatRelativeTime(agent._ts)

  const secsAgo = agent._ts ? (Date.now() - agent._ts) / 1000 : Infinity
  const nameOpacity = agent.dead ? 0.3 : secsAgo < 120 ? 1.0 : secsAgo < 600 ? 0.5 : 0.3

  return (
    <div className={`fleet-agents-row${dimmed ? ' dimmed' : ''}`}>
      {/* Status dot — removed, activity shown via name opacity */}

      {/* Agent name — draggable, opacity reflects activity */}
      <span
        className="fleet-agents-col-name fleet-agents-pill"
        style={{ color, opacity: nameOpacity }}
        onPointerDown={(e) => onStartDrag(e, 'agent', name, name, color)}
      >
        {name}
      </span>

      {/* Seen */}
      <span className="fleet-agents-col-seen">{ago}</span>

      {/* Task */}
      <span className="fleet-agents-col-task" title={taskDesc}>
        {taskDesc ? taskDesc.substring(0, 50) : ''}
      </span>

      {/* Labels — draggable chips */}
      <span className="fleet-agents-col-labels">
        {labels.map((label: string) => (
          <span
            key={label}
            className="fleet-agents-label-chip"
            style={{ background: labelColor(label) }}
            onPointerDown={(e) => onStartDrag(e, 'label', label, label, labelColor(label))}
          >
            {label}
          </span>
        ))}
      </span>
    </div>
  )
}
