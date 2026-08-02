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
  stopEventPropagation,
  useEditor,
  useValue,
  createShapeId,
  type TLShapeId,
} from 'tldraw'
import { fleetAgentsProps } from '../../shared/shapes/fleet-panel-schema.mjs'
import { useState, useCallback, useMemo, useRef, useEffect, memo, forwardRef, useContext } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useFleetAgents, useFleetAgentTotals, useFleetTasks, useFleetContext, useFleetProjects, useFleetIdentity, hibernateSession, spawnAgent, loadNextAgentsPage } from '../fleet-data-adapter'
import { dropPillOnTarget, fleetTaskDropBus } from './FleetPillShape'
import { markFleetPillActive, markFleetPillInactive, transientFleetPillProps } from './fleet-pill-transient'
import { agentDisplayLabel, beginFleetDragWithoutSnap, endFleetDragWithoutSnap } from './fleet-utils'
import { FleetPanelButtonGroup } from './FleetPanelChrome'
import { dragCoordinator } from './dragCoordinator'
import { useIsInViewport, useVisibilityViewportId } from './useIsInViewport'
import { fleetInteractionFrame, fleetPointerEventPagePoint } from '../wm/fleet-interaction-frame'
// @ts-ignore — vanilla JS module
import { fleetTaskDropTarget } from './fleet-task-inbox.mjs'
import { useAvailableSpawnModels } from '../fleet/useAvailableSpawnModels'
import { ProjectContext } from '../PanelContext'
import { activeMintToken, applyMintCandidate, parseMintInput } from '../fleet/mint-input'
import {
  FleetAgentDirectoryRow,
  fleetAgentCategory,
  fleetAgentLabelColor,
  formatFleetAgentModel,
  formatFleetAgentRelativeTime,
  getFleetAgentNickColor,
  projectFleetAgentDirectoryFolding,
  toFleetAgentDirectoryRow,
} from './FleetAgentDirectoryRow'


const DEFAULT_W = 340
const DEFAULT_H = 400

const CAT_NAMES = [
  'whiskers', 'mittens', 'shadow', 'luna', 'mochi', 'pepper', 'nugget', 'biscuit',
  'pickles', 'waffles', 'noodle', 'tofu', 'gizmo', 'beans', 'ziggy', 'cleo',
  'fig', 'olive', 'pixel', 'sprout', 'taco', 'chai', 'dumpling', 'mango',
  'pebble', 'sage', 'jinx', 'kiwi', 'marble', 'rumble',
]

function completeSegment(typed: string, candidates: string[]): string {
  if (!typed) return ''
  const match = candidates.find(c => c.startsWith(typed) && c !== typed)
  return match ? match.slice(typed.length) : ''
}

type SpawnOptionSpec = { default: string; values: Record<string, { options?: Record<string, SpawnOptionSpec> }> }
type SpawnOptionSpecs = Record<string, SpawnOptionSpec>

function activeSpawnOptions(base: SpawnOptionSpecs, selected: Record<string, string | undefined>): SpawnOptionSpecs {
  const out: SpawnOptionSpecs = {}
  const visit = (options: SpawnOptionSpecs) => {
    for (const [name, spec] of Object.entries(options || {})) {
      out[name] = spec
      const value = selected[name] || spec.default
      const child = spec.values?.[value]?.options
      if (child) visit(child)
    }
  }
  visit(base)
  return out
}

function optionCandidates(prefix: string, optionSpecs: SpawnOptionSpecs): string[] {
  const colon = prefix.indexOf(':')
  if (colon < 0) {
    const lower = prefix.toLowerCase()
    return Object.keys(optionSpecs)
      .filter(name => !prefix || name.toLowerCase().startsWith(lower))
      .map(name => `${name}:`)
  }
  const key = prefix.slice(0, colon)
  const typed = prefix.slice(colon + 1)
  const values = Object.keys(optionSpecs[key]?.values || {})
  const lower = typed.toLowerCase()
  return values
    .filter(value => !typed || value.toLowerCase().startsWith(lower))
}

function getGhostCompletion(input: string, projects: string[], catName: string, defaultDoc: string, models: string[], defaultModel: string, optionSpecs: SpawnOptionSpecs): string {
  const defaults = [defaultDoc || projects[0] || 'doc', catName, defaultModel]
  if (!input) return defaults.join(' ')
  const { pos, prefix } = activeMintToken(input)
  const pool = pos === 1 ? projects : pos === 2 ? CAT_NAMES : pos === 3 ? models : optionCandidates(prefix, optionSpecs)
  const typed = pos === 4 ? (prefix.includes(':') ? prefix.slice(prefix.indexOf(':') + 1) : prefix) : prefix
  const completion = completeSegment(typed, pool)
  if (pos === 4) return completion
  const remaining = defaults.slice(pos)
  return completion + (remaining.length ? ` ${remaining.join(' ')}` : '')
}

// Staged Tab completion fills only the active positional or keyword token.
// Returns the string to append, including the separating space when advancing
// to the next positional token.
function getStagedTabCompletion(input: string, projects: string[], catName: string, defaultDoc: string, models: string[], defaultModel: string, optionSpecs: SpawnOptionSpecs): string {
  const defaults = [defaultDoc || projects[0] || 'doc', catName, defaultModel]
  const { pos, prefix } = activeMintToken(input)
  const pool = pos === 1 ? projects : pos === 2 ? CAT_NAMES : pos === 3 ? models : optionCandidates(prefix, optionSpecs)
  const typed = pos === 4 ? (prefix.includes(':') ? prefix.slice(prefix.indexOf(':') + 1) : prefix) : prefix
  const completion = typed ? completeSegment(typed, pool) : (pos <= 3 ? defaults[pos - 1] || '' : '')
  return pos < 3 ? `${completion} ` : completion
}

const SEG_LABELS = ['project', 'name', 'model', 'option']

// Candidate list for the token the cursor is currently in.
// Shows canonical values only (not shorthand aliases) so the dropdown stays readable.
function getSegmentCandidates(input: string, projects: string[], models: string[], optionSpecs: SpawnOptionSpecs): { pos: number; prefix: string; candidates: string[] } {
  const { pos, prefix } = activeMintToken(input)
  let pool: string[] = []
  if (pos === 1) pool = projects
  else if (pos === 2) pool = CAT_NAMES
  else if (pos === 3) pool = models
  else if (pos === 4) pool = optionCandidates(prefix, optionSpecs)
  const typed = pos === 4 ? (prefix.includes(':') ? prefix.slice(prefix.indexOf(':') + 1) : prefix) : prefix
  const lower = typed.toLowerCase()
  const candidates = typed
    ? pool.filter(c => c.toLowerCase().startsWith(lower) && c !== typed)
    : pool
  return { pos, prefix, candidates }
}

function moveToSpawnSegment(
  input: string,
  pos: number,
  defaults: [string, string, string],
): string {
  const parsed = parseMintInput(input)
  const positional = [parsed.doc, parsed.name || '', parsed.model || '']
  for (let i = 0; i < pos - 1 && i < 3; i++) positional[i] ||= defaults[i] || ''
  if (pos <= 3) return positional.slice(0, pos).join(' ')
  const [optionName, optionValue] = Object.entries(parsed.options)[0] || ['effort', '']
  return `${positional.slice(0, 3).join(' ')} ${optionName}:${optionValue || ''}`
}

// The project that will actually be used: the typed first token, or — when
// the field is empty — the doc currently being viewed.
function effectiveDoc(input: string, currentDoc: string): string {
  return parseMintInput(input).doc || currentDoc
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
  modelOptions?: Record<string, string>
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

// agentDisplayLabel imported from ./fleet-utils — single source of truth so the
// panel and the chat target chip can't drift.

// --- Shape definition ---

export class FleetAgentsShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-agents' as const
  static override props = fleetAgentsProps

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, userId: '', deviceId: '' }
  }

  override canEdit = () => false
  override canResize = () => true
  override onTranslateStart = () => beginFleetDragWithoutSnap(this.editor)
  override onTranslateEnd = () => endFleetDragWithoutSnap(this.editor)
  override onTranslateCancel = () => endFleetDragWithoutSnap(this.editor)
  override canSnap = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

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
  pillType: 'agent' | 'label' | 'team'
  value: string
  displayName: string
  color: string
  startX: number
  startY: number
  started: boolean
  onTap?: (e: PointerEvent) => void
}

const DRAG_THRESHOLD = 5

export function usePillDrag() {
  const editor = useEditor()
  const viewportId = useVisibilityViewportId()
  const frame = useMemo(() => fleetInteractionFrame(viewportId), [viewportId])
  const dragRef = useRef<DragState | null>(null)
  const releaseRef = useRef<null | (() => void)>(null)

  const cancelDrag = useCallback(() => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.pillId) {
      markFleetPillInactive(String(drag.pillId))
      editor.run(() => {
        const id = drag.pillId as TLShapeId
        if (editor.getShape(id)) editor.deleteShapes([id])
      }, { history: 'ignore' })
    }
  }, [editor])

  const startDrag = useCallback((
    e: React.PointerEvent,
    pillType: 'agent' | 'label' | 'team',
    value: string,
    displayName: string,
    color: string,
    onTap?: (e: PointerEvent) => void,
  ) => {
    stopEventPropagation(e)
    e.preventDefault()
    dragRef.current = {
      pillId: null, pillType, value, displayName, color,
      startX: e.clientX, startY: e.clientY, started: false, onTap,
    }

    // Claim the shared drag coordinator — one global listener pair handles
    // move/up events, eliminating capture-phase registration races.
    releaseRef.current = dragCoordinator.claim(
      // onMove
      (ev: PointerEvent) => {
        const drag = dragRef.current
        if (!drag) return

        const dx = ev.clientX - drag.startX
        const dy = ev.clientY - drag.startY

        if (!drag.started) {
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
          drag.started = true

          const pagePos = fleetPointerEventPagePoint(editor, frame, ev)
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
              props: transientFleetPillProps({ w: pw, h: ph, pillType: drag.pillType, value: drag.value, displayName: drag.displayName, color: drag.color }),
            })
          }, { history: 'ignore' })
          drag.pillId = pillId as unknown as string
          markFleetPillActive(String(pillId))
          editor.cancel()
          return
        }

        if (drag.pillId) {
          const pagePos = fleetPointerEventPagePoint(editor, frame, ev)
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
        releaseRef.current = null
        if (!drag) return
        if (!drag.started || !drag.pillId) {
          drag.onTap?.(ev)
          return
        }
        markFleetPillInactive(String(drag.pillId))

        const pagePos = fleetPointerEventPagePoint(editor, frame, ev)
        const fleetTaskRow = fleetTaskDropTarget(
          document.elementsFromPoint(ev.clientX, ev.clientY),
          drag.pillType,
        ) as HTMLElement | null
        if (fleetTaskRow?.dataset.fleetTaskId) {
          fleetTaskDropBus.dispatchEvent(new CustomEvent('assign', {
            detail: {
              taskId: fleetTaskRow.dataset.fleetTaskId,
              inboxShapeId: fleetTaskRow.dataset.fleetInboxShapeId,
              agent: drag.value,
            },
          }))
        } else {
          dropPillOnTarget(editor, drag.pillId as TLShapeId, drag.value, pagePos)
        }
        editor.run(() => {
          try {
            const id = drag.pillId as TLShapeId
            if (editor.getShape(id)) {
              editor.deleteShapes([id])
            }
          } catch {
            // The drop already ran; leftover transient preview cleanup has no
            // owned non-modal surface in this drag coordinator.
          }
        }, { history: 'ignore' })
      },
      cancelDrag,
    )
  }, [cancelDrag, editor, frame])

  useEffect(() => () => {
    releaseRef.current?.()
    releaseRef.current = null
    cancelDrag()
  }, [cancelDrag])

  return { startDrag }
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
  const docCtx = useContext(ProjectContext)
  const currentDoc = docCtx?.projectName || ''
  const agents = useFleetAgents(frameId)
  const agentTotals = useFleetAgentTotals(frameId)
  const tasks = useFleetTasks(frameId)
  const { startDrag } = usePillDrag()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Optimistic spawn cards — transient per-device state, not shared.
  const [optimisticAgents, setOptimisticAgents] = useState<OptimisticAgent[]>([])
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
          // with a matching model alias. Uses formatFleetAgentModel to normalise
          // 'claude-opus-4-8' → 'opus48' so the comparison works across formats.
          return !existingSet.has(a.id) && formatFleetAgentModel(a.metadata?.model) === formatFleetAgentModel(opt.model)
        })
        if (matched) {
          changed = true
          return false
        }
        return true
      })
      return changed ? remaining : prev
    })
  }, [agents])

  const [sortKey, setSortKey] = useState<SortKey>('active')
  const [sortAsc, setSortAsc] = useState(false)

  // Spawn input — always visible, fetches projects for autocomplete.
  // Starts empty/ghosted; the ghost shows the current doc as the implied
  // project, so an empty submit spawns into the doc being viewed.
  const [spawnDoc, setSpawnDoc] = useState('')
  const { id: userId } = useFleetIdentity()
  // Live project list — re-fetches on the server's `projects-updated` event so a
  // newly-created project shows up here without a manual reload.
  const projectList = useFleetProjects()
  const parsedSpawn = useMemo(() => parseMintInput(spawnDoc), [spawnDoc])
  const spawnAvailabilityDoc = parsedSpawn.doc || currentDoc
  const spawnModelInfo = useAvailableSpawnModels(userId, { doc: spawnAvailabilityDoc })
  const spawnModels = spawnModelInfo.aliases
  const defaultSpawnModel = spawnModelInfo.defaultAlias
  const [catName] = useState(() => CAT_NAMES[Math.floor(Math.random() * CAT_NAMES.length)])
  const spawnInputRef = useRef<HTMLInputElement>(null)
  const [spawnFocused, setSpawnFocused] = useState(false)
  const [dropdownIdx, setDropdownIdx] = useState(-1) // -1 = nothing highlighted
  const [dropdownDismissed, setDropdownDismissed] = useState(false)
  const selectedModelOptions = useMemo(
    () => spawnModelInfo.models.find(model => model.alias === (parsedSpawn.model || defaultSpawnModel))?.options || {},
    [spawnModelInfo.models, parsedSpawn.model, defaultSpawnModel],
  )
  const activeOptionSpecs = useMemo(
    () => activeSpawnOptions(selectedModelOptions, parsedSpawn.options || {}),
    [selectedModelOptions, parsedSpawn.options],
  )
  const { pos: segPos, candidates: segCandidates } = useMemo(
    () => getSegmentCandidates(spawnDoc, projectList, spawnModels, activeOptionSpecs),
    [spawnDoc, projectList, spawnModels, activeOptionSpecs],
  )
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
  const spawnTooltip = spawnError || spawnValidationError || 'Mint agent'
  const submitSpawn = useCallback(() => {
    if (!canSubmitSpawn(spawnDoc, projectList, currentDoc)) {
      spawnInputRef.current?.focus()
      return
    }
    const { doc, name, model, options } = parsedSpawn
    setSpawnError('')

    // Add optimistic card immediately — the real agent will reconcile it away.
    const optimisticId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const effectiveModel = model || defaultSpawnModel
    const optimistic: OptimisticAgent = {
      optimisticId,
      model: effectiveModel,
      doc: doc || currentDoc || undefined,
      name: name || undefined,
      effort: options.effort || undefined,
      modelOptions: options,
      startedAt: Date.now(),
      status: 'spawning',
      // Snapshot current IDs for model-only reconciliation (a new agent with the
      // right model will have an ID that wasn't in this set).
      existingIds: agentsRef.current.map((a: any) => a.id),
    }
    setOptimisticAgents(prev => [...prev, optimistic])

    spawnAgent(effectiveModel || undefined, doc || currentDoc || undefined, name, options)
      .catch((e: any) => {
        const message = String(e?.message || e || 'Spawn failed')
        setSpawnError(message)
        spawnInputRef.current?.focus()
        // Mark the card errored — persists until dismissed or retried by the user.
        setOptimisticAgents(prev => prev.map(o =>
          o.optimisticId === optimisticId
            ? { ...o, status: 'error' as const, errorMessage: message }
            : o
        ))
      })
  }, [spawnDoc, projectList, currentDoc, parsedSpawn, defaultSpawnModel])
  const dropdownOpen = spawnFocused && !dropdownDismissed && segCandidates.length > 0
  const spawnDefaults = useMemo<[string, string, string]>(() => [
    currentDoc || projectList[0] || '',
    catName,
    defaultSpawnModel,
  ], [currentDoc, projectList, catName, defaultSpawnModel])
  const chooseSpawnField = useCallback((pos: number) => {
    setSpawnDoc(current => moveToSpawnSegment(current, pos, spawnDefaults))
    setDropdownIdx(-1)
    setDropdownDismissed(false)
    requestAnimationFrame(() => spawnInputRef.current?.focus())
  }, [spawnDefaults])
  const acceptCandidate = useCallback((candidate: string) => {
    setSpawnDoc(applyMintCandidate(spawnDoc, candidate))
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
      const band = formatFleetAgentRelativeTime(ts)
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
        const ca = order[fleetAgentCategory(a)] ?? 2
        const cb = order[fleetAgentCategory(b)] ?? 2
        return dir * (ca - cb) || agentDisplayLabel(a, agents).localeCompare(agentDisplayLabel(b, agents))
      }
      // "Active": stable sort keyed on the displayed time bucket. Different
      // buckets order by recency (the coarse continuum); within the SAME bucket,
      // keep order stable by entry time, so a freshly-jumped agent lands on top
      // and nothing else reshuffles while the display is identical.
      if (a._band !== b._band) return dir * (a._ts - b._ts)
      return dir * (a._bandEnteredAt - b._bandEnteredAt)
    })
    const byId = new Map(list.map(agent => [agent.id, agent]))
    const childrenByParent = new Map<string, any[]>()
    for (const agent of list) {
      if (!agent.parent_agent_id || !byId.has(agent.parent_agent_id)) continue
      const children = childrenByParent.get(agent.parent_agent_id) || []
      children.push(agent)
      childrenByParent.set(agent.parent_agent_id, children)
    }
    const visited = new Set<string>()
    const families: any[][] = []
    const appendFamily = (agent: any, family: any[]) => {
      if (!agent || visited.has(agent.id)) return
      visited.add(agent.id)
      family.push(agent)
      for (const child of childrenByParent.get(agent.id) || []) appendFamily(child, family)
    }
    for (const agent of list) {
      if (agent.parent_agent_id && byId.has(agent.parent_agent_id)) continue
      const family: any[] = []
      appendFamily(agent, family)
      families.push(family)
    }
    // Keep malformed/cyclic lineage visible instead of dropping rows.
    for (const agent of list) {
      if (visited.has(agent.id)) continue
      const family: any[] = []
      appendFamily(agent, family)
      families.push(family)
    }
    return families.flat()
  }, [agents, sortKey, sortAsc])

  // Playback has its own fixed roster; live panels use server-provided totals
  // that remain stable as virtualized pages materialize.
  const playbackCounts = useMemo(() => ({
    hibernating: sortedAgents.filter(a => fleetAgentCategory(a) === 'hibernating').length,
    awake: sortedAgents.filter(a => fleetAgentCategory(a) === 'awake').length,
  }), [sortedAgents])
  const hibernatingCount = frameId?.startsWith('shape:') ? playbackCounts.hibernating : agentTotals.hibernating
  const awakeCount = frameId?.startsWith('shape:') ? playbackCounts.awake : agentTotals.awake

  const [childFoldOverrides, setChildFoldOverrides] = useState<Record<string, boolean>>({})
  const childFolding = useMemo(
    () => projectFleetAgentDirectoryFolding(sortedAgents, childFoldOverrides),
    [sortedAgents, childFoldOverrides],
  )

  const contextPercent = useFleetContext(null, frameId)
  const rowItems = useMemo<AgentListItem[]>(
    () => [
      ...optimisticAgents.map((opt) => ({ type: 'optimistic' as const, opt })),
      ...childFolding.visibleAgents.map((agent) => ({ type: 'agent' as const, agent })),
    ],
    [optimisticAgents, childFolding.visibleAgents],
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
        <FleetPanelButtonGroup editor={editor} shape={shape} />

        {/* Header with sort toggle */}
        <div
          className="fleet-agents-header"
          onPointerDown={(e) => stopEventPropagation(e)}
        >
          <span className="fleet-agents-unread-dot" />
          <span style={{ width: 20, flexShrink: 0 }} />
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
          <span className="fleet-agents-col-labels">Label</span>
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
            endReached={() => { void loadNextAgentsPage() }}
            itemContent={(_, item) => (
              item.type === 'optimistic' ? (
                <OptimisticAgentRow
                  opt={item.opt}
                  onStartDrag={startDrag}
                  onDismiss={() => {
                    setOptimisticAgents(prev => prev.filter(o => o.optimisticId !== item.opt.optimisticId))
                  }}
                  onRetry={() => {
                    setOptimisticAgents(prev => prev.map(o =>
                      o.optimisticId === item.opt.optimisticId ? { ...o, status: 'spawning' as const, errorMessage: undefined } : o
                    ))
                    spawnAgent(item.opt.model || undefined, item.opt.doc, item.opt.name, item.opt.modelOptions || (item.opt.effort ? { effort: item.opt.effort } : {}))
                      .catch((e: any) => {
                        const msg = String(e?.message || e || 'Spawn failed')
                        setOptimisticAgents(prev => prev.map(o =>
                          o.optimisticId === item.opt.optimisticId ? { ...o, status: 'error' as const, errorMessage: msg } : o
                        ))
                      })
                  }}
                />
              ) : (
                (() => {
                  const agentTasks = getTasksForAgent(item.agent.id)
                  const taskText = agentTasks[0]?.title || agentTasks[0]?.description || ''
                  const childCount = childFolding.childCounts.get(item.agent.id) || 0
                  const childrenFolded = childFolding.foldedParentIds.has(item.agent.id)
                  const cycleAgentState = () => {
                    if (expandedId === item.agent.id) {
                      if (childCount > 0) {
                        setChildFoldOverrides(current => ({ ...current, [item.agent.id]: true }))
                      }
                      setExpandedId(null)
                      return
                    }
                    if (childCount > 0 && childrenFolded) {
                      setChildFoldOverrides(current => ({ ...current, [item.agent.id]: false }))
                      setExpandedId(null)
                      return
                    }
                    if (childCount > 0) {
                      setChildFoldOverrides(current => ({ ...current, [item.agent.id]: false }))
                    }
                    setExpandedId(item.agent.id)
                  }
                  return (
                    <FleetAgentDirectoryRow
                      row={toFleetAgentDirectoryRow(item.agent, { spawnModels: spawnModelInfo.models })}
                      taskDesc={taskText}
                      taskTitle={taskText}
                      tasks={agentTasks}
                      contextPct={contextPercent.get(item.agent.id)}
                      expanded={expandedId === item.agent.id}
                      childCount={childCount}
                      childrenFolded={childrenFolded}
                      knownProjects={projectList}
                      onCycleState={cycleAgentState}
                      onControlPointerDown={childCount > 0 ? (e) => startDrag(
                        e,
                        'team',
                        item.agent.id,
                        `${agentDisplayLabel(item.agent)} + team`,
                        getFleetAgentNickColor(item.agent.id),
                        cycleAgentState,
                      ) : undefined}
                      onHibernate={() => hibernateSession(item.agent.id)}
                      onAgentPointerDown={(e, row) => { e.stopPropagation(); startDrag(e, 'agent', row.exactName, row.displayName, row.color) }}
                      onLabelPointerDown={(e, label) => startDrag(e, 'label', label, label, fleetAgentLabelColor(label))}
                    />
                  )
                })()
              )
            )}
          />
        )}

        {/* Footer */}
        <div className="fleet-agents-footer">
          <span>
            <span
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => { e.stopPropagation(); startDrag(e, 'label', 'awake', 'awake', fleetAgentLabelColor('awake')) }}
            >{awakeCount} awake</span>
            {hibernatingCount > 0 && (
              <span style={{ marginLeft: 6 }}>·{' '}
                <span
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => { e.stopPropagation(); startDrag(e, 'label', 'hibernating', 'hibernating', fleetAgentLabelColor('hibernating')) }}
                >{hibernatingCount} hibernating</span>
              </span>
            )}
          </span>
          <span className={'fleet-agents-spawn-btns' + (spawnFocused ? ' is-open' : '')} onPointerDown={stopEventPropagation}>
            {spawnFocused && (
              <div className="fleet-agents-mint-picker" onPointerDown={stopEventPropagation}>
                <div className="fleet-agents-mint-fields" aria-label="mint agent fields">
                  {SEG_LABELS.slice(0, Object.keys(activeOptionSpecs).length ? 4 : 3).map((label, index) => (
                    <button
                      key={label}
                      type="button"
                      className={'fleet-agents-mint-field' + (segPos === index + 1 ? ' is-active' : '')}
                      onMouseDown={(e) => { e.preventDefault(); chooseSpawnField(index + 1) }}
                    >{label}</button>
                  ))}
                </div>
                <div className="fleet-agents-mint-choices" aria-label={`${SEG_LABELS[segPos - 1] || 'field'} choices`}>
                  {spawnModelInfo.loading && segPos === 3 ? (
                    <span className="fleet-agents-mint-empty">asking daemon…</span>
                  ) : spawnModelInfo.error && segPos === 3 ? (
                    <span className="fleet-agents-mint-empty">models unavailable</span>
                  ) : segCandidates.length ? segCandidates.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      className={'fleet-agents-mint-choice' + (segCandidates[dropdownIdx] === candidate ? ' is-active' : '')}
                      onMouseEnter={() => setDropdownIdx(segCandidates.indexOf(candidate))}
                      onMouseDown={(e) => { e.preventDefault(); acceptCandidate(candidate) }}
                    >{candidate}</button>
                  )) : (
                    <span className="fleet-agents-mint-empty">type to narrow</span>
                  )}
                </div>
              </div>
            )}
            <span className="fleet-agents-spawn-input-wrap">
              <input
                ref={spawnInputRef}
                className={'fleet-agents-spawn-search' + (spawnInvalid ? ' is-invalid' : '')}
                value={spawnDoc}
                title={spawnTooltip}
                aria-invalid={spawnInvalid || undefined}
                aria-describedby={spawnInvalid ? 'fleet-agents-spawn-error' : undefined}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                name="tlda-fleet-agent-spawn-target"
                spellCheck={false}
                onFocus={() => setSpawnFocused(true)}
                onBlur={(e) => {
                  if (e.currentTarget.closest('.fleet-agents-spawn-btns')?.contains(e.relatedTarget as Node | null)) return
                  setSpawnFocused(false)
                  setDropdownIdx(-1)
                }}
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
                    e.preventDefault()
                    setDropdownDismissed(true)
                    setDropdownIdx(-1)
                    setSpawnFocused(false)
                    spawnInputRef.current?.blur()
                  } else if (e.key === 'Tab') {
                    if (dropdownOpen && dropdownIdx >= 0) {
                      e.preventDefault()
                      acceptCandidate(segCandidates[dropdownIdx])
                    } else {
                      // Staged: complete one token per Tab.
                      const seg = getStagedTabCompletion(spawnDoc, projectList, catName, currentDoc, spawnModels, defaultSpawnModel, activeOptionSpecs)
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
                placeholder={spawnFocused ? '' : 'mint a new agent'}
              />
              {spawnFocused && <span className="fleet-agents-spawn-ghost"><span style={{ visibility: 'hidden' }}>{spawnDoc}</span>{getGhostCompletion(spawnDoc, projectList, catName, currentDoc, spawnModels, defaultSpawnModel, activeOptionSpecs)}</span>}
              {spawnInvalid && (
                <span id="fleet-agents-spawn-error" className="fleet-agents-spawn-error" role="alert">
                  {spawnTooltip}
                </span>
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

// Ghost row shown while a spawn is in flight. Matches the directory row column layout
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
  onStartDrag: (e: React.PointerEvent, pillType: 'agent' | 'label' | 'team', value: string, displayName: string, color: string) => void
}) {
  const isError = opt.status === 'error'
  const nameText = opt.name || '…'
  // A spawning agent is already a real chat target: drag its name to filter the
  // chat just like a live agent. The filter value is opt.name — the friendly_name
  // it will register with — so the filter carries over once it inhabits. Only a
  // named, non-errored card is a valid drag source.
  const canDrag = !isError && !!opt.name
  const dragColor = getFleetAgentNickColor(opt.name || opt.optimisticId, false)
  const modelStr = formatFleetAgentModel(opt.model)
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
