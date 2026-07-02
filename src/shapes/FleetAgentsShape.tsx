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
  useValue,
  createShapeId,
} from 'tldraw'
import { useState, useCallback, useMemo, useRef, useEffect, memo, forwardRef } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useFleetAgents, useFleetTasks, useFleetUnreadCounts, useFleetContext, useFleetProjects, useFleetIdentity, searchFleet, hibernateSession, spawnAgent } from '../fleet-data-adapter'
import { dropPillOnTarget } from './FleetPillShape'
import { agentDisplayLabel, agentExactName, beginNativeSnapDrag, endNativeSnapDrag } from './fleet-utils'
import { AgentName } from './PhaseIcon'
import { dragCoordinator } from './dragCoordinator'
import { useIsInViewport, useVisibilityViewportId } from './useIsInViewport'
import { clientPointToPage } from '../wm/viewport-coordinates'
import { useAvailableSpawnModels } from '../fleet/useAvailableSpawnModels'


const DEFAULT_W = 340
const DEFAULT_H = 400

const MODEL_SHORTHANDS: Record<string, string> = {
  'opus': 'opus', 'opus45': 'opus45', 'opus46': 'opus46', 'opus47': 'opus47', 'opus48': 'opus48',
  'sonnet': 'sonnet', 'haiku': 'haiku',
  '45': 'opus45', '46': 'opus46', '47': 'opus47', '48': 'opus48',
  's': 'sonnet', 'h': 'haiku',
  'o45': 'opus45', 'o46': 'opus46', 'o47': 'opus47', 'o48': 'opus48',
  'ds': 'deepseek',
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_SHORTHANDS: Record<string, string> = {
  'lo': 'low', 'low': 'low', 'l': 'low',
  'med': 'medium', 'medium': 'medium', 'm': 'medium',
  'hi': 'high', 'high': 'high', 'h': 'high',
  'xhi': 'xhigh', 'xhigh': 'xhigh', 'xh': 'xhigh', 'x': 'xhigh',
  'max': 'max',
}
// Empty-state model picks (shown before you type a model segment): the curated,
// diverse set we actively test — a few headline Claude families + the goose
// models teacher-dev runs in the manners-course sweep. Everything else (older
// versions, untested variants) still completes once you start typing letters,
// so the full alias list stays reachable; this just keeps the no-prefix list
// short and representative instead of a wall of Claude aliases. Goose subset
// confirmed with teacher-dev (the leaderboard set).
const CURATED_SPAWN_MODELS = [
  'opus', 'sonnet', 'haiku',
  'deepseek', 'kimi', 'qwen', 'glm', 'minimax', 'mistral',
]
const CAT_NAMES = [
  'whiskers', 'mittens', 'shadow', 'luna', 'mochi', 'pepper', 'nugget', 'biscuit',
  'pickles', 'waffles', 'noodle', 'tofu', 'gizmo', 'beans', 'ziggy', 'cleo',
  'fig', 'olive', 'pixel', 'sprout', 'taco', 'chai', 'dumpling', 'mango',
  'pebble', 'sage', 'jinx', 'kiwi', 'marble', 'rumble',
]

function parseSpawnInput(raw: string, models: string[] = []): { doc: string; name: string | undefined; model: string | undefined; effort: string | undefined } {
  const parts = raw.split(':')
  const doc = parts[0]
  if (parts.length === 2) {
    const model = MODEL_SHORTHANDS[parts[1]] || (models.includes(parts[1]) ? parts[1] : undefined)
    if (model) return { doc, name: undefined, model, effort: undefined }
  }
  const name = parts[1] || undefined
  const modelRaw = parts[2] || undefined
  const model = modelRaw ? (MODEL_SHORTHANDS[modelRaw] || modelRaw) : undefined
  const effortRaw = parts[3] || undefined
  const effort = effortRaw ? (EFFORT_SHORTHANDS[effortRaw] || undefined) : undefined
  return { doc, name, model, effort }
}

// Tab-completable model tokens = the live aliases plus the typing-shorthand keys.
function completableFrom(models: string[]): string[] {
  return [...models, ...Object.keys(MODEL_SHORTHANDS)].filter((v, i, a) => a.indexOf(v) === i)
}
const ALL_EFFORT_COMPLETABLE = [...EFFORT_LEVELS, ...Object.keys(EFFORT_SHORTHANDS)]
  .filter((v, i, a) => a.indexOf(v) === i)

function completeSegment(typed: string, candidates: string[]): string {
  if (!typed) return ''
  const match = candidates.find(c => c.startsWith(typed) && c !== typed)
  return match ? match.slice(typed.length) : ''
}

function getGhostCompletion(input: string, projects: string[], catName: string, defaultDoc: string, models: string[], defaultModel: string): string {
  // Empty-state default is the doc the user is currently viewing, not the
  // alphabetically-first project — so an empty field implies "spawn here".
  const defaults = [defaultDoc || projects[0] || 'doc', catName, defaultModel]
  if (!input) return defaults.join(':')

  const parts = input.split(':')
  const lastPart = parts[parts.length - 1]
  const pos = parts.length // 1-based: 1=project, 2=name, 3=model, 4=effort

  let segCompletion = ''
  if (!lastPart) {
    segCompletion = defaults[pos - 1] || ''
  } else if (pos === 1) {
    segCompletion = completeSegment(lastPart, projects)
  } else if (pos === 2) {
    segCompletion = completeSegment(lastPart, CAT_NAMES)
  } else if (pos === 3) {
    segCompletion = completeSegment(lastPart, completableFrom(models))
  } else if (pos === 4) {
    segCompletion = completeSegment(lastPart, ALL_EFFORT_COMPLETABLE)
  }

  const remaining = defaults.slice(pos)
  if (remaining.length > 0) {
    return segCompletion + ':' + remaining.join(':')
  }
  return segCompletion
}

// Staged Tab completion: fill in ONLY the current segment (up to the next colon)
// and advance to the next one, rather than expanding the whole 4-part spec at
// once. Returns the string to APPEND to the input. On a non-final segment it
// ends with ':' so the cursor lands at the start of the next segment; the final
// (effort) segment has no trailing colon. Returns '' when there's nothing to add
// (already past the last segment).
function getStagedTabCompletion(input: string, projects: string[], catName: string, defaultDoc: string, models: string[], defaultModel: string): string {
  const defaults = [defaultDoc || projects[0] || 'doc', catName, defaultModel]
  const parts = input.split(':')
  const pos = parts.length // 1-based: 1=project, 2=name, 3=model, 4=effort
  if (pos > defaults.length) return ''
  const lastPart = parts[parts.length - 1]

  let segCompletion = ''
  if (!lastPart) {
    segCompletion = defaults[pos - 1] || ''
  } else if (pos === 1) {
    segCompletion = completeSegment(lastPart, projects)
  } else if (pos === 2) {
    segCompletion = completeSegment(lastPart, CAT_NAMES)
  } else if (pos === 3) {
    segCompletion = completeSegment(lastPart, completableFrom(models))
  } else if (pos === 4) {
    segCompletion = completeSegment(lastPart, ALL_EFFORT_COMPLETABLE)
  }

  // Advance to the next segment on every segment but the last.
  return pos < defaults.length ? segCompletion + ':' : segCompletion
}

const SEG_LABELS = ['project', 'name', 'model', 'effort']

// Candidate list for the segment the cursor is currently in (the last colon-part).
// Shows canonical values only (not shorthand aliases) so the dropdown stays readable.
function getSegmentCandidates(input: string, projects: string[], models: string[], curatedModels: string[]): { pos: number; prefix: string; candidates: string[] } {
  const parts = input.split(':')
  const pos = parts.length // 1=project, 2=name, 3=model, 4=effort
  const prefix = parts[parts.length - 1]
  let pool: string[] = []
  if (pos === 1) pool = projects
  else if (pos === 2) pool = CAT_NAMES
  else if (pos === 3) pool = models
  else if (pos === 4) pool = EFFORT_LEVELS
  const lower = prefix.toLowerCase()
  // Model segment with nothing typed: show the curated/diverse set, not every
  // alias. Once a prefix is typed, fall through to the full model pool so any
  // model is still reachable by name.
  const candidates = prefix
    ? pool.filter(c => c.toLowerCase().startsWith(lower) && c !== prefix)
    : (pos === 3 ? curatedModels : pool)
  return { pos, prefix, candidates }
}

// Replace the current (last) segment's typed prefix with the chosen candidate.
function applyCandidate(input: string, candidate: string): string {
  const parts = input.split(':')
  parts[parts.length - 1] = candidate
  return parts.join(':')
}

// The project that will actually be used: the typed first segment, or — when
// the field is empty — the doc currently being viewed.
function effectiveDoc(input: string, currentDoc: string): string {
  return input.split(':')[0] || currentDoc
}

// True when a project is named but won't resolve to a known project. Used to
// flag the field and block submit, so a non-existent project (the `dot-claude`
// bug) can't silently produce a dead agent. Returns false while the project
// list is still loading, or while the typed prefix could still complete to a
// real project (so mid-typing doesn't flash red).
function projectUnresolvable(input: string, projects: string[], currentDoc: string): boolean {
  if (!projects.length) return false
  const doc = effectiveDoc(input, currentDoc)
  if (!doc) return false
  if (projects.includes(doc)) return false
  const lower = doc.toLowerCase()
  const hasPrefixMatch = projects.some(p => p.toLowerCase().startsWith(lower))
  return !hasPrefixMatch
}

// Submit is allowed only when the effective project is empty (spawn with no
// cwd) or resolves exactly to a known project.
function canSubmitSpawn(input: string, projects: string[], currentDoc: string): boolean {
  if (!projects.length) return true
  const doc = effectiveDoc(input, currentDoc)
  return !doc || projects.includes(doc)
}

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

type SortKey = 'active' | 'name' | 'status'

// --- Optimistic spawn card ---
// Appears immediately when the user submits a spawn; disappears when the real
// agent registers (reconciled by name or model+novelty). Transient per-device
// state — kept in React component state, not shared via Yjs or shape props.
interface OptimisticAgent {
  optimisticId: string
  model: string        // alias as sent to spawn (e.g. 'opus48')
  doc?: string
  name?: string        // friendly_name the real agent will register with
  effort?: string
  startedAt: number    // Date.now() at submit
  status: 'spawning' | 'error'
  errorMessage?: string
  existingIds: string[] // agent IDs present at spawn time (model-only reconciliation)
}

type AgentListItem =
  | { type: 'optimistic'; opt: OptimisticAgent }
  | { type: 'agent'; agent: any }

const FleetAgentsScroller = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function FleetAgentsScroller(props, ref) {
    const className = props.className ? `fleet-agents-body ${props.className}` : 'fleet-agents-body'
    return <div {...props} ref={ref} className={className} />
  },
)
const FLEET_AGENTS_VIRTUOSO_COMPONENTS = { Scroller: FleetAgentsScroller }

function agentCategory(agent: any): 'awake' | 'hibernating' {
  if (agent.status === 'human') return 'awake'
  if (agent.status === 'human-away') return 'hibernating'
  return agent.status === 'awake' ? 'awake' : 'hibernating'
}

// Display a model by Skip's convention: no decimals, no dashes, no provider
// prefix. claude-opus-4-8 -> opus48, gpt-5.5 -> gpt55, deepseek/deepseek-v4-pro
// -> deepseekv4pro, minimax/minimax-m3 -> minimaxm3.
function formatModel(model: string | null | undefined): string {
  if (!model) return ''
  let s = model.includes('/') ? model.split('/').pop()! : model
  s = s.replace(/^claude-/, '')
  return s.replace(/[.\-]/g, '')
}

// Surface the agent's capability / fence in the panel (topic-1: capability
// discoverable in the agent panel). Derived from metadata.spawnPolicy, which the
// server stamps at spawn (the resolved capability + filesystem policy).
// Skip's four names are the only capability labels shown in the UI. Net is
// always on, so there is no "nonet" capability to surface. Legacy machine words
// (still in pre-rename agents' metadata until they respawn) map to the four names.
const CAPABILITY_LABELS: Record<string, string> = {
  read: 'read',
  write: 'write',
  'tlda-write': 'tlda-write',
  full: 'full',
  'read-only': 'read',
  'workspace-write': 'write',
  'workspace-write+net': 'write',
  'workspace-write-no-net': 'write',
  'full-access': 'full',
}
const POLICY_LABELS: Record<string, string> = {
  cwd: 'own project',
  'tlda-projects': 'all projects',
  unsandboxed: 'machine',
}
function formatCapability(meta: any): string {
  const sp = meta?.spawnPolicy
  if (!sp) return ''
  const cap = typeof sp === 'string' ? sp : sp.capability
  const policy = typeof sp === 'object' ? sp.policy : null
  if (!cap) return ''
  const capLabel = CAPABILITY_LABELS[cap] || cap
  const policyLabel = policy ? (POLICY_LABELS[policy] || policy) : ''
  return policyLabel ? `${capLabel} · ${policyLabel}` : capLabel
}

function formatEffort(effort: string | null | undefined, kind: string | null | undefined): string {
  if (!effort || kind !== 'claude') return ''
  return `${effort} effort`
}


// agentDisplayLabel imported from ./fleet-utils — single source of truth so the
// panel and the chat target chip can't drift.

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
    userId: T.optional(T.string),
    deviceId: T.optional(T.string),
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, userId: '', deviceId: '' }
  }

  override canEdit = () => false
  override canResize = () => true
  override canSnap = () => true
  override canBind = () => false
  override hideRotateHandle = () => true
  override onTranslateStart = () => beginNativeSnapDrag(this.editor)
  override onTranslateEnd = () => endNativeSnapDrag(this.editor)
  override onTranslateCancel = () => endNativeSnapDrag(this.editor)

  component(shape: any) {
    return <FleetAgentsComponent shape={shape} />
  }

  getIndicatorPath() {
    return undefined
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

export function usePillDrag() {
  const editor = useEditor()
  const viewportId = useVisibilityViewportId()
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

          const pagePos = clientPointToPage(editor, { x: ev.clientX, y: ev.clientY }, viewportId)
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
          const pagePos = clientPointToPage(editor, { x: ev.clientX, y: ev.clientY }, viewportId)
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
        }
      },
      // onUp
      (ev: PointerEvent) => {
        const drag = dragRef.current
        dragRef.current = null
        if (!drag || !drag.started || !drag.pillId) return

        const pagePos = clientPointToPage(editor, { x: ev.clientX, y: ev.clientY }, viewportId)
        dropPillOnTarget(editor, drag.pillId as any, drag.value, pagePos)
        editor.run(() => {
          try { editor.deleteShapes([drag.pillId as any]) } catch {}
        }, { history: 'ignore' })
      },
    )
  }, [editor, viewportId])

  return { startDrag }
}


// Fetch last message per agent from search API (batched, cached)
const lastMessageCache = new Map<string, { text: string; ts: number; fetched: number }>()

async function fetchLastMessage(agentName: string): Promise<{ text: string; ts: number } | null> {
  const cached = lastMessageCache.get(agentName)
  if (cached && Date.now() - cached.fetched < 30_000) return cached
  // /api/logs/search doesn't exist on the unified server yet — skip to avoid 404 spam
  return null
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
    const names = agents.map(a => agentExactName(a))
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

function FleetAgentsInner({ shape }: { shape: any }) {
  const editor = useEditor()
  const { w, h } = shape.props
  const containerRef = useRef<HTMLDivElement>(null)
  const isSelectedRef = useRef(false)
  isSelectedRef.current = useValue('isSelected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])

  // Capture-phase pointerdown: fires before tldraw's tl-container listener
  // can intercept. Marks non-drag clicks as handled so tldraw skips
  // setPointerCapture (which would steal the event from shape content).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement
      if (!el!.contains(target)) return
      // If shape is selected for drag/resize, let tldraw handle everything
      if (isSelectedRef.current) return
      // Let pill-drag elements handle their own events (they call stopEventPropagation)
      const isDraggable = target.closest('.fleet-agents-pill, .fleet-agents-label-chip')
      if (isDraggable) return
      // Mark handled on BOTH this editor and the main editor — each editor
      // tracks handled events independently, and the main editor's capture
      // listener fires before the overlay editor's (higher in DOM tree).
      editor.markEventAsHandled(e)
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [editor])

  const frameId = shape.parentId as string | undefined
  const agents = useFleetAgents(frameId)
  const tasks = useFleetTasks(frameId)
  const { startDrag } = usePillDrag()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Optimistic spawn cards — transient per-device state, not shared.
  const [optimisticAgents, setOptimisticAgents] = useState<OptimisticAgent[]>([])
  // Timeout handles keyed by optimisticId — allows cancellation on reconciliation or error.
  const optimisticTimeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // Stable ref for agents so submitSpawn can read the current list without
  // taking agents as a dep (it changes frequently and would re-create the callback).
  const agentsRef = useRef<any[]>(agents)
  agentsRef.current = agents

  // Reconcile: drop an optimistic card when a matching real agent arrives.
  // Runs on every agents update; uses functional-update pattern to avoid
  // needing optimisticAgents in deps (preventing a setState→effect→setState loop).
  useEffect(() => {
    setOptimisticAgents(prev => {
      if (prev.length === 0) return prev
      let changed = false
      const remaining = prev.filter(opt => {
        const existingSet = new Set(opt.existingIds)
        const matched = agents.some((a: any) => {
          if (a.dead) return false
          // Name-based: the real agent registers with the same friendly_name
          if (opt.name) return a.friendly_name === opt.name
          // Model-based fallback: a NEW agent (not in existingIds at spawn time)
          // with a matching model alias. Uses formatModel to normalise
          // 'claude-opus-4-8' → 'opus48' so the comparison works across formats.
          return !existingSet.has(a.id) && formatModel(a.metadata?.model) === formatModel(opt.model)
        })
        if (matched) {
          const tid = optimisticTimeouts.current.get(opt.optimisticId)
          if (tid != null) { clearTimeout(tid); optimisticTimeouts.current.delete(opt.optimisticId) }
          changed = true
          return false
        }
        return true
      })
      return changed ? remaining : prev
    })
  }, [agents])

  // Cancel all pending timeouts when this component unmounts.
  useEffect(() => () => {
    for (const tid of optimisticTimeouts.current.values()) clearTimeout(tid)
  }, [])
  const [sortKey, setSortKey] = useState<SortKey>('active')
  const [sortAsc, setSortAsc] = useState(false)

  // Spawn input — always visible, fetches projects for autocomplete.
  // Starts empty/ghosted; the ghost shows the current doc as the implied
  // project, so an empty submit spawns into the doc being viewed.
  const currentDoc = useMemo(() => new URLSearchParams(window.location.search).get('doc') || '', [])
  const [spawnDoc, setSpawnDoc] = useState('')
  const { id: userId } = useFleetIdentity()
  // Live project list — re-fetches on the server's `projects-updated` event so a
  // newly-created project shows up here without a manual reload.
  const projectList = useFleetProjects()
  const spawnModelInfo = useAvailableSpawnModels(userId)
  const spawnModels = spawnModelInfo.aliases
  const defaultSpawnModel = spawnModelInfo.defaultAlias
  // Curated empty-state picks, intersected with what's actually available (and
  // verified) so a removed/renamed alias never shows a dead entry; curated order
  // preserved.
  const curatedSpawnModels = useMemo(
    () => CURATED_SPAWN_MODELS.filter(a => spawnModels.includes(a)),
    [spawnModels],
  )
  const [catName] = useState(() => CAT_NAMES[Math.floor(Math.random() * CAT_NAMES.length)])
  const spawnInputRef = useRef<HTMLInputElement>(null)
  const [spawnFocused, setSpawnFocused] = useState(false)
  const [dropdownIdx, setDropdownIdx] = useState(-1) // -1 = nothing highlighted
  const [dropdownDismissed, setDropdownDismissed] = useState(false)
  const { pos: segPos, candidates: segCandidates } = useMemo(
    () => getSegmentCandidates(spawnDoc, projectList, spawnModels, curatedSpawnModels),
    [spawnDoc, projectList, spawnModels, curatedSpawnModels],
  )
  const parsedSpawn = useMemo(() => parseSpawnInput(spawnDoc, spawnModels), [spawnDoc, spawnModels])
  const projectInvalid = useMemo(
    () => projectUnresolvable(spawnDoc, projectList, currentDoc),
    [spawnDoc, projectList, currentDoc],
  )
  // spawnError holds a real spawn FAILURE (set in submitSpawn's catch), shown
  // briefly in the tooltip. Name-collision pre-checking is intentionally not
  // done here — friendly-name uniqueness is a separate concern handled server-side.
  const [spawnError, setSpawnError] = useState('')
  const spawnValidationError = projectInvalid
    ? `No project '${effectiveDoc(spawnDoc, currentDoc)}'`
    : ''
  const spawnInvalid = projectInvalid || !!spawnError
  const spawnTooltip = spawnError || spawnValidationError || 'Spawn agent'
  const submitSpawn = useCallback(() => {
    if (!canSubmitSpawn(spawnDoc, projectList, currentDoc)) {
      spawnInputRef.current?.focus()
      return
    }
    const { doc, name, model, effort } = parsedSpawn
    setSpawnError('')

    // Add optimistic card immediately — the real agent will reconcile it away.
    const optimisticId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const effectiveModel = model || defaultSpawnModel
    const optimistic: OptimisticAgent = {
      optimisticId,
      model: effectiveModel,
      doc: doc || currentDoc || undefined,
      name: name || undefined,
      effort: effort || undefined,
      startedAt: Date.now(),
      status: 'spawning',
      // Snapshot current IDs for model-only reconciliation (a new agent with the
      // right model will have an ID that wasn't in this set).
      existingIds: agentsRef.current.map((a: any) => a.id),
    }
    setOptimisticAgents(prev => [...prev, optimistic])

    // Safety: drop the card after 30s if reconciliation never happens.
    const safeTid = setTimeout(() => {
      setOptimisticAgents(prev => prev.filter(o => o.optimisticId !== optimisticId))
      optimisticTimeouts.current.delete(optimisticId)
    }, 30_000)
    optimisticTimeouts.current.set(optimisticId, safeTid)

    spawnAgent(effectiveModel || undefined, doc || currentDoc || undefined, name, effort)
      .catch((e: any) => {
        const message = String(e?.message || e || 'Spawn failed')
        setSpawnError(message)
        spawnInputRef.current?.focus()
        // Mark the card errored — persists until dismissed or retried by the user.
        const existing = optimisticTimeouts.current.get(optimisticId)
        if (existing != null) { clearTimeout(existing); optimisticTimeouts.current.delete(optimisticId) }
        setOptimisticAgents(prev => prev.map(o =>
          o.optimisticId === optimisticId
            ? { ...o, status: 'error' as const, errorMessage: message }
            : o
        ))
      })
  }, [spawnDoc, projectList, currentDoc, parsedSpawn, defaultSpawnModel])
  const dropdownOpen = spawnFocused && !dropdownDismissed && segCandidates.length > 0
  const acceptCandidate = useCallback((candidate: string) => {
    setSpawnDoc(applyCandidate(spawnDoc, candidate))
    setDropdownIdx(-1)
    setDropdownDismissed(true)
    spawnInputRef.current?.focus()
  }, [spawnDoc])

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

  // Per-agent state for the "Active" sort: the agent's current *displayed* time
  // bucket ("now"/"1m"/"2m"/…) and WHEN it entered it. The Active sort is a stable
  // sort keyed on that displayed bucket — agents in the same bucket keep their
  // order (no reshuffling while everyone reads "now"), and an agent only moves
  // when its displayed value actually ticks over, jumping to the TOP of the new
  // bucket.
  const bandStateRef = useRef<Map<string, { band: string; enteredAt: number }>>(new Map())

  const sortedAgents = useMemo(() => {
    const now = Date.now()
    const liveIds = new Set<string>()
    const list: any[] = []
    for (const a of agents) {
      if (a.dead) continue
      const ts = a.last_active ? new Date(a.last_active).getTime() : 0
      // The band IS the displayed time bucket — same value the row shows.
      const band = formatRelativeTime(ts)
      liveIds.add(a.id)
      const prev = bandStateRef.current.get(a.id)
      if (!prev || prev.band !== band) bandStateRef.current.set(a.id, { band, enteredAt: now })
      const enteredAt = bandStateRef.current.get(a.id)!.enteredAt
      list.push({ ...a, _ts: ts, _band: band, _bandEnteredAt: enteredAt })
    }
    // Drop state for agents that have left the list so the map doesn't grow.
    for (const id of bandStateRef.current.keys()) if (!liveIds.has(id)) bandStateRef.current.delete(id)
    const dir = sortAsc ? 1 : -1
    list.sort((a, b) => {
      if (sortKey === 'name') return dir * agentDisplayLabel(a, agents).localeCompare(agentDisplayLabel(b, agents))
      if (sortKey === 'status') {
        const order: Record<string, number> = { awake: 0, hibernating: 1 }
        const ca = order[agentCategory(a)] ?? 2
        const cb = order[agentCategory(b)] ?? 2
        return dir * (ca - cb) || b._ts - a._ts
      }
      // "Active": stable sort keyed on the displayed time bucket. Different
      // buckets order by recency (the coarse continuum); within the SAME bucket,
      // keep order stable by entry time, so a freshly-jumped agent lands on top
      // and nothing else reshuffles while the display is identical.
      if (a._band !== b._band) return dir * (a._ts - b._ts)
      return dir * (a._bandEnteredAt - b._bandEnteredAt)
    })
    return list
  }, [agents, sortKey, sortAsc])

  const hibernatingCount = useMemo(() => sortedAgents.filter(a => agentCategory(a) === 'hibernating').length, [sortedAgents])
  const awakeCount = sortedAgents.length - hibernatingCount

  // Fetch last messages for visible agents
  const lastMessages = useLastMessages(sortedAgents)

  const unreadCounts = useFleetUnreadCounts()
  const contextPercent = useFleetContext(null, frameId)
  const rowItems = useMemo<AgentListItem[]>(
    () => [
      ...optimisticAgents.map((opt) => ({ type: 'optimistic' as const, opt })),
      ...sortedAgents.map((agent) => ({ type: 'agent' as const, agent })),
    ],
    [optimisticAgents, sortedAgents],
  )

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
        ref={containerRef}
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
              editor.setCurrentTool('select')
              editor.select(shape.id)
            }}
            title="Resize / move"
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
          <span style={{ width: 18, flexShrink: 0 }} />
          <span className="fleet-agents-col-name fleet-agents-sort-header"
            onPointerUp={(e) => { e.stopPropagation(); if (sortKey === 'name') setSortAsc(p => !p); else { setSortKey('name'); setSortAsc(false) } }}
            style={{ cursor: 'pointer' }}
          >Agent {sortKey === 'name' ? (sortAsc ? '▴' : '▾') : ''}</span>
          <span className="fleet-agents-col-seen fleet-agents-sort-header"
            onPointerUp={(e) => { e.stopPropagation(); if (sortKey === 'active') setSortAsc(p => !p); else { setSortKey('active'); setSortAsc(false) } }}
            style={{ cursor: 'pointer' }}
          >Active {sortKey === 'active' ? (sortAsc ? '▴' : '▾') : ''}</span>
          <span className="fleet-agents-col-ctx">Ctx</span>
          <span className="fleet-agents-col-task fleet-agents-sort-header"
            onPointerUp={(e) => { e.stopPropagation(); if (sortKey === 'status') setSortAsc(p => !p); else { setSortKey('status'); setSortAsc(false) } }}
            style={{ cursor: 'pointer' }}
          >Task {sortKey === 'status' ? (sortAsc ? '▴' : '▾') : ''}</span>
          <span className="fleet-agents-col-labels">Labels</span>
        </div>

        {/* Agent rows — scrollable flat list */}
        {sortedAgents.length === 0 && optimisticAgents.length === 0 ? (
          <div className="fleet-agents-body">
            <div className="fleet-agents-empty">No agents</div>
          </div>
        ) : (
          <Virtuoso
            data={rowItems}
            components={FLEET_AGENTS_VIRTUOSO_COMPONENTS}
            style={{ flex: 1, minHeight: 0 }}
            overscan={240}
            itemContent={(_, item) => (
              item.type === 'optimistic' ? (
                <OptimisticAgentRow
                  opt={item.opt}
                  onStartDrag={startDrag}
                  onDismiss={() => {
                    const tid = optimisticTimeouts.current.get(item.opt.optimisticId)
                    if (tid != null) { clearTimeout(tid); optimisticTimeouts.current.delete(item.opt.optimisticId) }
                    setOptimisticAgents(prev => prev.filter(o => o.optimisticId !== item.opt.optimisticId))
                  }}
                  onRetry={() => {
                    setOptimisticAgents(prev => prev.map(o =>
                      o.optimisticId === item.opt.optimisticId ? { ...o, status: 'spawning' as const, errorMessage: undefined } : o
                    ))
                    const safeTid = setTimeout(() => {
                      setOptimisticAgents(prev => prev.filter(o => o.optimisticId !== item.opt.optimisticId))
                      optimisticTimeouts.current.delete(item.opt.optimisticId)
                    }, 30_000)
                    optimisticTimeouts.current.set(item.opt.optimisticId, safeTid)
                    spawnAgent(item.opt.model || undefined, item.opt.doc, item.opt.name, item.opt.effort)
                      .catch((e: any) => {
                        const msg = String(e?.message || e || 'Spawn failed')
                        const ex = optimisticTimeouts.current.get(item.opt.optimisticId)
                        if (ex != null) { clearTimeout(ex); optimisticTimeouts.current.delete(item.opt.optimisticId) }
                        setOptimisticAgents(prev => prev.map(o =>
                          o.optimisticId === item.opt.optimisticId ? { ...o, status: 'error' as const, errorMessage: msg } : o
                        ))
                      })
                  }}
                />
              ) : (
                <AgentRow
                  agent={item.agent}
                  allAgents={agents}
                  tasks={getTasksForAgent(item.agent.id)}
                  unreadCount={unreadCounts[item.agent.id] || 0}
                  contextPct={contextPercent.get(item.agent.id)}
                  dimmed={agentCategory(item.agent) === 'hibernating'}
                  expanded={expandedId === item.agent.id}
                  lastMessage={lastMessages[agentExactName(item.agent)] || ''}
                  onToggleExpand={() => setExpandedId(expandedId === item.agent.id ? null : item.agent.id)}
                  onStartDrag={startDrag}
                />
              )
            )}
          />
        )}

        {/* Footer */}
        <div className="fleet-agents-footer">
          <span>
            <span
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => { e.stopPropagation(); startDrag(e, 'label', 'awake', 'awake', labelColor('awake')) }}
            >{awakeCount} awake</span>
            {hibernatingCount > 0 && (
              <span style={{ marginLeft: 6 }}>·{' '}
                <span
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => { e.stopPropagation(); startDrag(e, 'label', 'hibernating', 'hibernating', labelColor('hibernating')) }}
                >{hibernatingCount} hibernating</span>
              </span>
            )}
          </span>
          <span className="fleet-agents-spawn-btns" onPointerDown={(e) => e.stopPropagation()}>
            <span className="fleet-agents-spawn-input-wrap">
              <input
                ref={spawnInputRef}
                className={'fleet-agents-spawn-search' + (spawnInvalid ? ' is-invalid' : '')}
                value={spawnDoc}
                title={spawnTooltip}
                aria-invalid={spawnInvalid || undefined}
                aria-describedby={spawnInvalid ? 'fleet-agents-spawn-error' : undefined}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onFocus={() => setSpawnFocused(true)}
                onBlur={() => { setSpawnFocused(false); setDropdownIdx(-1) }}
                onChange={(e) => { setSpawnDoc(e.target.value); setSpawnError(''); setDropdownIdx(-1); setDropdownDismissed(false) }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setDropdownDismissed(false)
                    if (segCandidates.length) setDropdownIdx(i => Math.min(i + 1, segCandidates.length - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setDropdownIdx(i => Math.max(i - 1, -1))
                  } else if (e.key === 'Escape') {
                    if (dropdownOpen) { e.preventDefault(); setDropdownDismissed(true); setDropdownIdx(-1) }
                  } else if (e.key === 'Tab') {
                    if (dropdownOpen && dropdownIdx >= 0) {
                      e.preventDefault()
                      acceptCandidate(segCandidates[dropdownIdx])
                    } else {
                      // Staged: complete one segment (to the next colon) per Tab,
                      // not the whole spec at once.
                      const seg = getStagedTabCompletion(spawnDoc, projectList, catName, currentDoc, spawnModels, defaultSpawnModel)
                      if (seg) { e.preventDefault(); setSpawnDoc(spawnDoc + seg); setDropdownDismissed(true) }
                    }
                  } else if (e.key === 'Enter') {
                    e.preventDefault()
                    if (dropdownOpen && dropdownIdx >= 0) {
                      acceptCandidate(segCandidates[dropdownIdx])
                    } else {
                      submitSpawn()
                    }
                  }
                }}
                placeholder=""
              />
              <span className="fleet-agents-spawn-ghost"><span style={{ visibility: 'hidden' }}>{spawnDoc}</span>{getGhostCompletion(spawnDoc, projectList, catName, currentDoc, spawnModels, defaultSpawnModel)}</span>
              {spawnInvalid && (
                <span id="fleet-agents-spawn-error" className="fleet-agents-spawn-error" role="alert">
                  {spawnTooltip}
                </span>
              )}
              {dropdownOpen && (
                <ul className="fleet-agents-spawn-dropdown" onPointerDown={(e) => e.stopPropagation()}>
                  <li className="fleet-agents-spawn-dropdown-label">{SEG_LABELS[segPos - 1]}</li>
                  {segCandidates.map((c, i) => (
                    <li
                      key={c}
                      className={'fleet-agents-spawn-dropdown-item' + (i === dropdownIdx ? ' is-active' : '')}
                      onMouseEnter={() => setDropdownIdx(i)}
                      onMouseDown={(e) => { e.preventDefault(); acceptCandidate(c) }}
                    >{c}</li>
                  ))}
                </ul>
              )}
            </span>
            <button
              className={'fleet-agents-spawn-btn' + (spawnInvalid ? ' is-disabled' : '')}
              title={spawnTooltip}
              onPointerUp={(e) => {
                e.stopPropagation()
                submitSpawn()
              }}
            >+</button>
          </span>
        </div>
      </div>
    </HTMLContainer>
  )
}

const FleetAgentsComponent = memo(function FleetAgentsComponent({ shape }: { shape: any }) {
  const { w, h } = shape.props as { w: number; h: number }
  const isInViewport = useIsInViewport(shape.id)
  if (!isInViewport) {
    return <HTMLContainer id={shape.id}><div style={{ width: w, height: h }} /></HTMLContainer>
  }
  return <FleetAgentsInner shape={shape} />
}, (prev, next) => prev.shape.props === next.shape.props)

// Ghost row shown while a spawn is in flight. Matches AgentRow column layout
// but is visually dimmed and shows a small spinning indicator instead of a name.
// In error state, hovering reveals dismiss (×) and retry controls.
function OptimisticAgentRow({
  opt,
  onDismiss,
  onRetry,
  onStartDrag,
}: {
  opt: OptimisticAgent
  onDismiss: () => void
  onRetry: () => void
  onStartDrag: (e: React.PointerEvent, pillType: 'agent' | 'label', value: string, displayName: string, color: string) => void
}) {
  const isError = opt.status === 'error'
  const nameText = opt.name || '…'
  // A spawning agent is already a real chat target: drag its name to filter the
  // chat just like a live agent. The filter value is opt.name — the friendly_name
  // it will register with — so the filter carries over once it inhabits. Only a
  // named, non-errored card is a valid drag source.
  const canDrag = !isError && !!opt.name
  const dragColor = getNickColor(opt.name || opt.optimisticId, false)
  const modelStr = formatModel(opt.model)
  const [hovered, setHovered] = useState(false)
  const showActions = isError && hovered
  return (
    <div
      className={`fleet-agents-row fleet-agents-row--optimistic${isError ? ' fleet-agents-row--spawn-error' : ''}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <div
        className="fleet-agents-row-main"
        style={{ opacity: 0.45, cursor: 'default' }}
        onPointerDown={(e) => stopEventPropagation(e)}
      >
        <span className="fleet-agents-unread-dot" />
        {/* dismiss button replaces kill-btn slot in error+hover state */}
        <button
          className={`fleet-agents-kill-btn fleet-agents-opt-dismiss${showActions ? ' is-visible' : ''}`}
          style={{ visibility: showActions ? 'visible' : 'hidden' }}
          onPointerDown={(e) => { stopEventPropagation(e); e.preventDefault() }}
          onClick={(e) => { e.stopPropagation(); onDismiss() }}
          aria-label="Dismiss"
        >×</button>
        <span
          className="fleet-agents-col-name"
          style={{ display: 'flex', alignItems: 'center', gap: 3, ...(canDrag ? { cursor: 'grab', touchAction: 'none' } : null) }}
          onPointerDown={canDrag ? (e) => { e.stopPropagation(); onStartDrag(e, 'agent', opt.name!, opt.name!, dragColor) } : undefined}
        >
          {!isError && <span className="fleet-agents-spawn-spinner" aria-hidden="true" />}
          {isError && <span className="fleet-agents-opt-error-icon" aria-hidden="true">✗</span>}
          <span style={{ opacity: 0.75 }}>{nameText}</span>
        </span>
        <span className="fleet-agents-col-seen">now</span>
        <span className="fleet-agents-col-ctx" />
        <span className="fleet-agents-col-task" style={{ opacity: 0.6 }}>
          {isError && !showActions && (opt.errorMessage || 'spawn failed')}
          {showActions && (
            <button
              className="fleet-agents-opt-retry"
              onPointerDown={(e) => { stopEventPropagation(e); e.preventDefault() }}
              onClick={(e) => { e.stopPropagation(); onRetry() }}
            >Retry</button>
          )}
          {!isError && `spawning ${modelStr}`}
        </span>
        <span className="fleet-agents-col-labels" />
      </div>
    </div>
  )
}

function AgentRow({
  agent,
  allAgents,
  tasks,
  dimmed,
  unreadCount,
  contextPct,
  expanded,
  lastMessage,
  onToggleExpand,
  onStartDrag,
}: {
  agent: any
  allAgents: any[]
  tasks: any[]
  dimmed?: boolean
  unreadCount: number
  contextPct?: number
  expanded: boolean
  lastMessage: string
  onToggleExpand: () => void
  onStartDrag: (e: React.PointerEvent, pillType: 'agent' | 'label', value: string, displayName: string, color: string) => void
}) {
  const firstTask = tasks[0]
  const taskDesc = firstTask?.title || firstTask?.description || ''
  const name = agentDisplayLabel(agent, allAgents)
  const color = getNickColor(agent.id, agent.is_manager)
  const labels: string[] = agent.labels || []
  const ago = formatRelativeTime(agent._ts)
  const meta = agent.metadata || {}
  const modelStr = formatModel(meta.model)
  const effortStr = formatEffort(meta.effort, meta.kind)
  const capStr = formatCapability(meta)
  const machineStr = agent.machine_id || ''
  const taskTitle = taskDesc
  // Desktop hover summary (touch users get the same via tap-to-expand).
  const hoverTitle = [name, machineStr && `machine: ${machineStr}`, modelStr && `model: ${modelStr}`, ago && `seen ${ago}`]
    .filter(Boolean)
    .join('  ·  ')

  const secsAgo = agent._ts ? (Date.now() - agent._ts) / 1000 : Infinity
  const nameOpacity = secsAgo < 120 ? 1.0 : secsAgo < 600 ? 0.85 : 0.65

  return (
    <div className={`fleet-agents-row${dimmed ? ' dimmed' : ''}${expanded ? ' expanded' : ''}`}>
      {/* Line 1: compact row */}
      <div
        className="fleet-agents-row-main"
        onPointerDown={(e) => stopEventPropagation(e)}
        onPointerUp={(e) => {
          e.stopPropagation()
          onToggleExpand()
        }}
      >
        <span className={`fleet-agents-unread-dot${unreadCount > 0 ? ' active' : ''}`} />

        {/* Hibernate button — shown on hover, kills session but keeps agent in panel */}
        <span
          className="fleet-agents-kill-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => { e.stopPropagation(); hibernateSession(agent.id) }}
          title="Hibernate agent"
        >
          ×
        </span>

        {/* Agent name — draggable, with phase icon for dawn/dusk */}
        <span
          className="fleet-agents-col-name fleet-agents-pill"
          style={{ color, opacity: nameOpacity, display: 'flex', alignItems: 'center' }}
          title={hoverTitle}
          onPointerDown={(e) => { e.stopPropagation(); onStartDrag(e, 'agent', agent.friendly_name || name, name, color) }}
        >
          {/* Fixed-width glyph slot (blank for dawn) so base names column-align */}
          <AgentName name={agent.friendly_name} slotWidth={15} />
        </span>

        <span className="fleet-agents-col-seen">{ago}</span>

        <span
          className="fleet-agents-col-ctx"
          style={contextPct != null ? { color: contextPct <= 15 ? '#e57373' : contextPct <= 30 ? '#ffb74d' : '#81c784' } : undefined}
        >
          {contextPct != null ? `${contextPct}%` : ''}
        </span>

        <span className="fleet-agents-col-task" title={taskTitle}>
          <span>{taskDesc ? taskDesc.substring(0, 50) : ''}</span>
        </span>

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

      {/* Expanded detail: meta line (machine · model · effort · cap · seen),
          current task in full, remaining tasks, last message */}
      {expanded && (
        <div className="fleet-agents-row-detail" onPointerDown={(e) => stopEventPropagation(e)}>
          <div className="fleet-agents-detail-meta">
            {machineStr && <span className="fleet-agents-detail-machine" title="machine">{machineStr}</span>}
            {modelStr && <span className="fleet-agents-detail-model">{modelStr}</span>}
            {effortStr && <span className="fleet-agents-detail-effort">{effortStr}</span>}
            {capStr && <span className="fleet-agents-detail-cap" title="capability / fence">{capStr}</span>}
            {ago && <span className="fleet-agents-detail-seen">seen {ago}</span>}
          </div>
          <div className="fleet-agents-detail-current">
            {tasks.length === 0
              ? '(no task)'
              : tasks[0].title || tasks[0].description || '(untitled task)'}
          </div>
          {tasks.slice(1).map((t: any, i: number) => (
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
