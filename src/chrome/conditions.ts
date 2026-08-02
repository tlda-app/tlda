/* Conditions on the bottom-right chrome buttons.
 *
 * The vertical stack of corner buttons is TOPICS. Each button grows LEFTWARD
 * with the conditions currently true for its topic, so a button carrying
 * several shows all of them without anything being opened.
 *
 * Three severities, one shared vocabulary:
 *   warning  — icon in the leftward stack
 *   error    — icon in the leftward stack
 *   severe   — icon in the stack AND the big button itself goes red
 *
 * A severe condition still says what it is (the stack) on top of saying it
 * cannot wait (the red). Those are two different questions, and dropping the
 * icon would answer only the second.
 *
 * Empty is silent: a topic with no conditions renders nothing, and its button
 * looks exactly as it did before.
 */

export type ConditionSeverity = 'warning' | 'error' | 'severe'

/** One topic per bottom-right button. */
export type ConditionTopic = 'fleet' | 'voice' | 'input'

export type ChromeCondition = {
  /** Stable per condition. Re-registering the same id replaces it. */
  id: string
  topic: ConditionTopic
  severity: ConditionSeverity
  /** Short text shown in the detail view. One line. */
  text: string
}

const SEVERITY_RANK: Record<ConditionSeverity, number> = {
  severe: 3,
  error: 2,
  warning: 1,
}

const conditions = new Map<string, ChromeCondition>()
const listeners = new Set<() => void>()

/** Per-topic snapshot cache. useSyncExternalStore compares snapshots by
 * reference, so a topic whose conditions did not change has to keep handing
 * back the same array or its button re-renders on every unrelated change. */
let snapshots = new Map<ConditionTopic, ChromeCondition[]>()

const EMPTY: ChromeCondition[] = []

function emit() {
  snapshots = new Map()
  for (const listener of listeners) listener()
}

/** Register a condition, or replace the one already registered under this id. */
export function setChromeCondition(condition: ChromeCondition): void {
  const previous = conditions.get(condition.id)
  if (
    previous &&
    previous.topic === condition.topic &&
    previous.severity === condition.severity &&
    previous.text === condition.text
  ) {
    return
  }
  conditions.set(condition.id, condition)
  emit()
}

/** Clear a condition by id. Clearing one that is not set is a no-op. */
export function clearChromeCondition(id: string): void {
  if (!conditions.delete(id)) return
  emit()
}

export function subscribeChromeConditions(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/** Conditions for a topic, most severe first. Stable by reference between
 * changes that do not affect this topic. */
export function getChromeConditions(topic: ConditionTopic): ChromeCondition[] {
  const cached = snapshots.get(topic)
  if (cached) return cached
  const next = [...conditions.values()]
    .filter((condition) => condition.topic === topic)
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
  const value = next.length === 0 ? EMPTY : next
  snapshots.set(topic, value)
  return value
}

/** The highest severity currently true for a topic, or null if it is silent. */
export function getChromeConditionSeverity(topic: ConditionTopic): ConditionSeverity | null {
  let highest: ConditionSeverity | null = null
  for (const condition of getChromeConditions(topic)) {
    if (!highest || SEVERITY_RANK[condition.severity] > SEVERITY_RANK[highest]) {
      highest = condition.severity
    }
  }
  return highest
}

declare global {
  interface Window {
    __tldaChromeConditions: {
      set: typeof setChromeCondition
      clear: typeof clearChromeCondition
      get: typeof getChromeConditions
      severity: typeof getChromeConditionSeverity
    }
  }
}

/* Registering a condition from outside a module graph — the same calls, for
 * subsystems that reach the page without importing it and for inspecting what
 * a button is currently carrying. */
window.__tldaChromeConditions = {
  set: setChromeCondition,
  clear: clearChromeCondition,
  get: getChromeConditions,
  severity: getChromeConditionSeverity,
}

/** Every topic that has a button, bottom of the stack first. */
export const CONDITION_TOPICS: readonly ConditionTopic[] = ['input', 'voice', 'fleet']

/** The element each topic's conditions hang off. The corner buttons are four
 * separately-positioned fixed elements whose offsets are redeclared per
 * viewport mode with env() and viewport-unit vars, so conditions are placed by
 * measuring the button rather than by a fifth copy of that ladder. */
export const CONDITION_ANCHOR_SELECTOR: Record<ConditionTopic, string> = {
  fleet: '.fleet-icon-pill-badge',
  voice: '.voice-note-btn',
  input: '.phone-hl-btn',
}
