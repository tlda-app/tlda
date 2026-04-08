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
import { useFleetAgents, useFleetTasks, useFleetUnreadCounts, searchFleet, respawnAgent, spawnAgent } from '../fleet-data-adapter'
import { dropPillOnTarget, computeDropSlot, dropGhostState, dropGhostBus } from './FleetPillShape'
import { dragCoordinator } from './dragCoordinator'
import { toggleLayoutMode, useLayoutMode } from './HudLayoutMode'


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

// --- Service health polling ---
interface ServiceHealth {
  tlda: { ok: boolean; uptime?: number }
  fleet: { ok: boolean; error?: string | null; uptime?: number }
  sync: { ok: boolean }
}

function useServiceHealth(): ServiceHealth | null {
  const [health, setHealth] = useState<ServiceHealth | null>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>
    let mounted = true

    async function check() {
      try {
        const r = await fetch('/health/services', { signal: AbortSignal.timeout(3000) })
        if (r.ok && mounted) setHealth(await r.json())
        else if (mounted) setHealth({ tlda: { ok: true }, fleet: { ok: false, error: 'HTTP ' + r.status }, sync: { ok: true } })
      } catch {
        // If we can't reach /health/services, the tlda server itself is down
        if (mounted) setHealth({ tlda: { ok: false }, fleet: { ok: false, error: 'unreachable' }, sync: { ok: false } })
      }
    }

    check()
    timer = setInterval(check, 15_000) // poll every 15s
    return () => { mounted = false; clearInterval(timer) }
  }, [])

  return health
}

type SortKey = 'seen' | 'name' | 'status'

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

    // Claim the shared drag coordinator — one global listener pair handles
    // move/up events, eliminating capture-phase registration races.
    dragCoordinator.claim(
      // onMove
      (ev: PointerEvent) => {
        const drag = dragRef.current
        if (!drag) return

        const dx = ev.clientX - drag.startX
        const dy = ev.clientY - drag.startY

        if (!drag.started) {
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
          drag.started = true

          const pagePos = editor.screenToPage({ x: ev.clientX, y: ev.clientY })
          const measureEl = document.createElement('span')
          measureEl.style.cssText = "position:absolute;visibility:hidden;font:500 9px 'SF Mono',Menlo,Consolas,monospace;white-space:nowrap;padding:1px 6px;border:1px solid transparent"
          measureEl.textContent = drag.displayName
          document.body.appendChild(measureEl)
          const pw = measureEl.offsetWidth
          const ph = measureEl.offsetHeight
          document.body.removeChild(measureEl)
          const pillId = createShapeId()
          editor.run(() => {
            editor.createShape({
              id: pillId,
              type: 'fleet-pill' as any,
              x: pagePos.x - pw / 2,
              y: pagePos.y - ph / 2,
              props: { w: pw, h: ph, pillType: drag.pillType, value: drag.value, displayName: drag.displayName, color: drag.color },
            })
          }, { history: 'ignore' })
          drag.pillId = pillId as unknown as string
          editor.cancel()
          return
        }

        if (drag.pillId) {
          const pagePos = editor.screenToPage({ x: ev.clientX, y: ev.clientY })
          const pillShape = editor.getShape(drag.pillId as any) as any
          const pw = pillShape?.props?.w || 70
          const ph = pillShape?.props?.h || 18
          editor.run(() => {
            editor.updateShape({
              id: drag.pillId as any,
              type: 'fleet-pill' as any,
              x: pagePos.x - pw / 2,
              y: pagePos.y - ph / 2,
            })
          }, { history: 'ignore' })
          const mainEditor = (window as any).__tldraw_editor__
          const targetEditor = mainEditor || editor
          dropGhostState.slot = computeDropSlot(targetEditor, null, pagePos.x, pagePos.y)
          dropGhostBus.dispatchEvent(new CustomEvent('change'))
        }
      },
      // onUp
      (ev: PointerEvent) => {
        const drag = dragRef.current
        dragRef.current = null
        if (!drag || !drag.started || !drag.pillId) return

        dropGhostState.slot = null
        dropGhostBus.dispatchEvent(new CustomEvent('change'))

        const pagePos = editor.screenToPage({ x: ev.clientX, y: ev.clientY })
        dropPillOnTarget(editor, drag.pillId as any, drag.value, pagePos)
        editor.run(() => {
          try { editor.deleteShapes([drag.pillId as any]) } catch {}
        }, { history: 'ignore' })
      },
    )
  }, [editor])

  return { startDrag }
}


// Fetch last message per agent from search API (batched, cached)
const lastMessageCache = new Map<string, { text: string; ts: number; fetched: number }>()

async function fetchLastMessage(agentName: string): Promise<{ text: string; ts: number } | null> {
  const cached = lastMessageCache.get(agentName)
  if (cached && Date.now() - cached.fetched < 30_000) return cached
  try {
    // Search for the agent name — the API does FTS, then we filter client-side
    const results = await searchFleet(agentName, 20)
    // Find messages actually from this agent
    const fromAgent = results.filter((r: any) => {
      const fromName = (r.from || '').replace('fleet:', '')
      return fromName === agentName || fromName.includes(agentName)
    })
    const match = fromAgent[0] || results[0]
    if (match) {
      const text = (match.snippet || match.text || match.message || match.body || '').replace(/<[^>]*>/g, '').replace(/[⟨⟩]{2}/g, '').replace(/\s+/g, ' ').trim()
      const ts = match.timestamp ? new Date(match.timestamp).getTime() : Date.now()
      const entry = { text, ts, fetched: Date.now() }
      lastMessageCache.set(agentName, entry)
      return entry
    }
  } catch {}
  return null
}

function useLastMessages(agents: any[]): Record<string, string> {
  const [messages, setMessages] = useState<Record<string, string>>({})

  useEffect(() => {
    let mounted = true
    const names = agents.map(a => agentDisplayName(a))
    Promise.all(names.map(async (name) => {
      const msg = await fetchLastMessage(name)
      return [name, msg?.text || ''] as const
    })).then(pairs => {
      if (!mounted) return
      const map: Record<string, string> = {}
      for (const [name, text] of pairs) if (text) map[name] = text
      setMessages(map)
    })
    return () => { mounted = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.length])

  return messages
}

function FleetAgentsComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const layoutMode = useLayoutMode()
  const { w, h } = shape.props
  const frameId = shape.parentId as string | undefined
  const agents = useFleetAgents(frameId)
  const tasks = useFleetTasks(frameId)
  const { startDrag } = usePillDrag()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('seen')
  const [sortAsc, setSortAsc] = useState(false)

  // Build task lookup: agent id → active task
  const activeTasks = useMemo(() => {
    return tasks.filter((t: any) => t.status === 'pending' || t.status === 'in_progress')
  }, [tasks])

  const getTasksForAgent = useCallback((agentId: string): any[] => {
    const shortId = agentId.replace(/-.*$/, '')
    const matches = activeTasks.filter((t: any) => {
      const assignee = t.agent || t.assignee || ''
      if (assignee === agentId) return true
      return assignee.replace(/-.*$/, '') === shortId
    })
    // Prefer non-synthetic tasks, but include all
    return matches.length > 0 ? matches : []
  }, [activeTasks])

  // Categorize and sort agents — stale agents are inline, not collapsed
  const { activeAgents, deadAgents } = useMemo(() => {
    const active: any[] = []
    const dead: any[] = []
    for (const a of agents) {
      if (a.human) continue
      const ts = a.last_seen ? new Date(a.last_seen).getTime() : 0
      const enriched = { ...a, _ts: ts }
      const cat = agentCategory(a)
      if (cat === 'dead') dead.push(enriched)
      else active.push(enriched) // alive + stale together
    }
    const dir = sortAsc ? 1 : -1
    const sortFn = (a: any, b: any) => {
      if (sortKey === 'name') return dir * agentDisplayName(a).localeCompare(agentDisplayName(b))
      if (sortKey === 'status') {
        const order = { alive: 0, stale: 1, dead: 2 }
        const ca = order[agentCategory(a) as keyof typeof order] ?? 1
        const cb = order[agentCategory(b) as keyof typeof order] ?? 1
        return dir * (ca - cb) || b._ts - a._ts
      }
      return dir * (b._ts - a._ts) // 'seen' — most recent first (default desc)
    }
    active.sort(sortFn)
    dead.sort((a: any, b: any) => b._ts - a._ts)
    return { activeAgents: active, deadAgents: dead }
  }, [agents, sortKey, sortAsc])

  const staleCount = useMemo(() => activeAgents.filter(a => agentCategory(a) === 'stale').length, [activeAgents])
  const aliveCount = activeAgents.length - staleCount

  // Fetch last messages for visible agents
  const lastMessages = useLastMessages(activeAgents)

  const [showDead, setShowDead] = useState(false)
  const unreadCounts = useFleetUnreadCounts()
  const serviceHealth = useServiceHealth()

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
        pointerEvents: layoutMode ? 'none' : 'all',
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
            className={`fleet-layout-btn${layoutMode ? ' active' : ''}`}
            onPointerUp={(e) => {
              e.stopPropagation()
              toggleLayoutMode(editor)
            }}
            title={layoutMode ? 'Exit layout mode' : 'Enter layout mode'}
          >
            ⊞
          </button>
        </div>

        {/* Header with sort toggle */}
        <div
          className="fleet-agents-header"
          onPointerDown={(e) => stopEventPropagation(e)}
        >
          <span className="fleet-agents-unread-dot" />
          <span className="fleet-agents-col-name fleet-agents-sort-header"
            onPointerUp={(e) => { e.stopPropagation(); if (sortKey === 'name') setSortAsc(p => !p); else { setSortKey('name'); setSortAsc(false) } }}
            style={{ cursor: 'pointer' }}
          >Agent {sortKey === 'name' ? (sortAsc ? '▴' : '▾') : ''}</span>
          <span className="fleet-agents-col-seen fleet-agents-sort-header"
            onPointerUp={(e) => { e.stopPropagation(); if (sortKey === 'seen') setSortAsc(p => !p); else { setSortKey('seen'); setSortAsc(false) } }}
            style={{ cursor: 'pointer' }}
          >Seen {sortKey === 'seen' ? (sortAsc ? '▴' : '▾') : ''}</span>
          <span className="fleet-agents-col-task fleet-agents-sort-header"
            onPointerUp={(e) => { e.stopPropagation(); if (sortKey === 'status') setSortAsc(p => !p); else { setSortKey('status'); setSortAsc(false) } }}
            style={{ cursor: 'pointer' }}
          >Task {sortKey === 'status' ? (sortAsc ? '▴' : '▾') : ''}</span>
          <span className="fleet-agents-col-labels">Labels</span>
        </div>

        {/* Agent rows — scrollable. Alive + stale inline, only dead collapses */}
        <div className="fleet-agents-body">
          {activeAgents.length === 0 && deadAgents.length === 0 ? (
            <div className="fleet-agents-empty">No agents</div>
          ) : (
            <>
              {activeAgents.map((agent: any) => {
                const isStale = agentCategory(agent) === 'stale'
                return (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    tasks={getTasksForAgent(agent.id)}
                    unreadCount={unreadCounts[agent.id] || 0}
                    dimmed={isStale}
                    canRespawn={isStale}
                    expanded={expandedId === agent.id}
                    lastMessage={lastMessages[agentDisplayName(agent)] || ''}
                    onToggleExpand={() => setExpandedId(expandedId === agent.id ? null : agent.id)}
                    onStartDrag={startDrag}
                  />
                )
              })}

              {deadAgents.length > 0 && (
                <>
                  <div
                    className="fleet-agents-section-header"
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => {
                      e.stopPropagation()
                      setShowDead(!showDead)
                    }}
                  >
                    <span className="fleet-agents-section-toggle">
                      {showDead ? '▾' : '▸'}
                    </span>
                    <span>dead</span>
                    <span className="fleet-agents-section-count">({deadAgents.length})</span>
                  </div>
                  {showDead && deadAgents.map((agent: any) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      tasks={getTasksForAgent(agent.id)}
                      unreadCount={unreadCounts[agent.id] || 0}
                      dimmed
                      canRespawn
                      expanded={expandedId === agent.id}
                      lastMessage=""
                      onToggleExpand={() => setExpandedId(expandedId === agent.id ? null : agent.id)}
                      onStartDrag={startDrag}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </div>

        {/* Service health dots */}
        {serviceHealth && (
          <div className="fleet-agents-health">
            <HealthDot ok={serviceHealth.tlda.ok} label="tlda" />
            <HealthDot ok={serviceHealth.fleet.ok} label="fleet" detail={serviceHealth.fleet.error} />
            <HealthDot ok={serviceHealth.sync.ok} label="sync" />
          </div>
        )}

        {/* Footer */}
        <div className="fleet-agents-footer">
          <span>
            {aliveCount} online
            {staleCount > 0 && <span style={{ marginLeft: 6 }}>· {staleCount} stale</span>}
          </span>
          <span className="fleet-agents-spawn-btns" onPointerDown={(e) => e.stopPropagation()}>
            <button
              className="fleet-agents-spawn-btn"
              title="Spawn Sonnet agent"
              onPointerUp={(e) => { e.stopPropagation(); spawnAgent('claude-sonnet-4-6') }}
            >+S</button>
            <button
              className="fleet-agents-spawn-btn"
              title="Spawn Opus agent"
              onPointerUp={(e) => { e.stopPropagation(); spawnAgent('claude-opus-4-6') }}
            >+O</button>
          </span>
        </div>
      </div>
    </HTMLContainer>
  )
}

function HealthDot({ ok, label, detail }: { ok: boolean; label: string; detail?: string | null }) {
  return (
    <span className="fleet-health-dot-item" title={ok ? `${label}: ok` : `${label}: ${detail || 'down'}`}>
      <span className={`fleet-health-indicator ${ok ? 'ok' : 'down'}`} />
      <span className="fleet-health-label">{label}</span>
    </span>
  )
}

function AgentRow({
  agent,
  tasks,
  dimmed,
  canRespawn,
  unreadCount,
  expanded,
  lastMessage,
  onToggleExpand,
  onStartDrag,
}: {
  agent: any
  tasks: any[]
  dimmed?: boolean
  canRespawn?: boolean
  unreadCount: number
  expanded: boolean
  lastMessage: string
  onToggleExpand: () => void
  onStartDrag: (e: React.PointerEvent, pillType: 'agent' | 'label', value: string, displayName: string, color: string) => void
}) {
  const firstTask = tasks[0]
  const taskDesc = firstTask?.title || firstTask?.description || ''
  const name = agentDisplayName(agent)
  const color = getNickColor(agent.id, agent.is_manager)
  const labels: string[] = agent.labels || []
  const ago = formatRelativeTime(agent._ts)

  const secsAgo = agent._ts ? (Date.now() - agent._ts) / 1000 : Infinity
  const nameOpacity = agent.dead ? 0.4 : secsAgo < 120 ? 1.0 : secsAgo < 600 ? 0.85 : 0.65

  return (
    <div className={`fleet-agents-row${dimmed ? ' dimmed' : ''}${expanded ? ' expanded' : ''}`}>
      {/* Line 1: compact row. Click anywhere to expand (name + labels are draggable, respawn is its own action) */}
      <div
        className="fleet-agents-row-main"
        onPointerDown={(e) => stopEventPropagation(e)}
        onPointerUp={(e) => {
          e.stopPropagation()
          onToggleExpand()
        }}
      >
        <span className={`fleet-agents-unread-dot${unreadCount > 0 ? ' active' : ''}`} />

        {/* Agent name — draggable (drag to create pill filter). Stops row click via onStartDrag's stopEventPropagation */}
        <span
          className={`fleet-agents-col-name fleet-agents-pill`}
          style={{ color, opacity: nameOpacity }}
          onPointerDown={(e) => { e.stopPropagation(); onStartDrag(e, 'agent', name, name, color) }}
        >
          {name}
        </span>

        <span className="fleet-agents-col-seen">{ago}</span>

        <span className="fleet-agents-col-task" title={taskDesc}>
          {taskDesc ? taskDesc.substring(0, 50) : ''}
        </span>

        {/* Respawn button — its own action, not expand */}
        {canRespawn && (
          <span
            className="fleet-agents-respawn-btn"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => { e.stopPropagation(); respawnAgent(agent.id) }}
            title="Respawn agent"
          >
            ⟳
          </span>
        )}

        {/* Labels — draggable chips */}
        <span className="fleet-agents-col-labels" onPointerDown={(e) => e.stopPropagation()}>
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

      {/* Expanded detail: all tasks + last message */}
      {expanded && (
        <div className="fleet-agents-row-detail" onPointerDown={(e) => stopEventPropagation(e)}>
          {tasks.length === 0 ? (
            <div className="fleet-agents-detail-task">(no task)</div>
          ) : tasks.map((t: any, i: number) => (
            <div key={t.id || i} className="fleet-agents-detail-task">
              {t.title || t.description || '(untitled task)'}
            </div>
          ))}
          {lastMessage && (
            <div className="fleet-agents-detail-message">
              "{lastMessage.length > 80 ? lastMessage.substring(0, 80) + '…' : lastMessage}"
            </div>
          )}
        </div>
      )}
    </div>
  )
}
