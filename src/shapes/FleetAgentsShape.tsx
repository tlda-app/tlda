/**
 * FleetAgentsShape — tldraw canvas shape showing alive fleet agents.
 *
 * Fetches from fleet API /api/state, shows agent name + status + task.
 * Click on an agent logs the ID (future: update filter on nearby fleet-chat shapes).
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
} from 'tldraw'
import { useState, useEffect, useCallback, useMemo } from 'react'

const FLEET_API = 'http://localhost:5199'
const DEFAULT_W = 300
const DEFAULT_H = 400

// --- Types ---

interface FleetAgent {
  id: string
  friendly_name: string | null
  labels: string[] | null
  last_seen: string | null
  dead: boolean
  human: boolean
  is_manager: boolean
  cwd: string | null
}

interface FleetTask {
  id: string
  title: string | null
  status: string | null
  assignee: string | null
}

function isAlive(agent: FleetAgent): boolean {
  if (agent.dead) return false
  if (!agent.last_seen) return false
  const seen = new Date(agent.last_seen).getTime()
  return Date.now() - seen < 120_000
}

function agentDisplayName(agent: FleetAgent): string {
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

  const [agents, setAgents] = useState<FleetAgent[]>([])
  const [tasks, setTasks] = useState<FleetTask[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const resp = await fetch(`${FLEET_API}/api/state`)
      if (!resp.ok) throw new Error(`${resp.status}`)
      const state = await resp.json()
      setAgents(state.agents || [])
      setTasks(state.tasks || [])
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const timer = setInterval(fetchData, 5000)
    return () => clearInterval(timer)
  }, [fetchData])

  const aliveAgents = useMemo(() => {
    return agents
      .filter(a => isAlive(a) && !a.human)
      .sort((a, b) => agentDisplayName(a).localeCompare(agentDisplayName(b)))
  }, [agents])

  const taskByAgent = useMemo(() => {
    const map: Record<string, FleetTask> = {}
    for (const t of tasks) {
      if (t.assignee && (t.status === 'pending' || t.status === 'in_progress')) {
        map[t.assignee] = t
      }
    }
    return map
  }, [tasks])

  const handleClick = useCallback((agentId: string) => {
    setSelectedId(prev => prev === agentId ? null : agentId)
    // Update filter on nearby fleet-chat shapes
    const allShapes = editor.getCurrentPageShapes()
    for (const s of allShapes) {
      if (s.type === 'fleet-chat') {
        editor.updateShape({
          id: s.id,
          type: 'fleet-chat',
          props: { ...(s as any).props, filter: agentId },
        })
      }
    }
  }, [editor])

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
          backgroundColor: 'var(--color-background, #1e1e1e)',
          border: '1px solid rgba(128, 128, 128, 0.2)',
          borderRadius: 8,
          fontSize: 11,
          color: 'var(--color-text, #e0e0e0)',
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
          {error && <span style={{ color: '#ef4444', fontWeight: 400 }}>· {error}</span>}
        </div>

        {/* Agent list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
          {aliveAgents.length === 0 ? (
            <div style={{
              padding: '20px 8px',
              opacity: 0.3,
              textAlign: 'center',
              fontSize: 10,
            }}>
              {error ? 'Fleet offline' : 'No agents online'}
            </div>
          ) : (
            aliveAgents.map(agent => {
              const name = agentDisplayName(agent)
              const task = taskByAgent[agent.id]
              const isSelected = selectedId === agent.id
              const ts = agent.last_seen ? new Date(agent.last_seen).getTime() : undefined
              return (
                <div
                  key={agent.id}
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
                    handleClick(agent.id)
                  }}
                >
                  {/* Avatar */}
                  <div style={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    background: agent.is_manager
                      ? 'rgba(139, 92, 246, 0.3)'
                      : 'rgba(128, 128, 128, 0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 9,
                    fontWeight: 600,
                    flexShrink: 0,
                    textTransform: 'uppercase',
                  }}>
                    {name.charAt(0)}
                  </div>

                  {/* Info */}
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
                      <span style={{ fontWeight: 600, fontSize: 11 }}>{name}</span>
                      {agent.is_manager && (
                        <span style={{
                          fontSize: 8,
                          padding: '0 3px',
                          borderRadius: 2,
                          background: 'rgba(139, 92, 246, 0.2)',
                          color: '#a78bfa',
                        }}>mgr</span>
                      )}
                    </div>
                    {task && (
                      <span style={{
                        fontSize: 9,
                        opacity: 0.5,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {task.title || 'working...'}
                      </span>
                    )}
                  </div>

                  {/* Seen time */}
                  <span style={{
                    fontSize: 9,
                    opacity: 0.35,
                    flexShrink: 0,
                  }}>
                    {formatRelativeTime(ts)}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>
    </HTMLContainer>
  )
}
