import { useCallback, useSyncExternalStore } from 'react'
import {
  getChromeConditions,
  getChromeConditionSeverity,
  subscribeChromeConditions,
  type ChromeCondition,
  type ConditionSeverity,
  type ConditionTopic,
} from './conditions'

/** Conditions currently true for a topic, most severe first. */
export function useChromeConditions(topic: ConditionTopic): ChromeCondition[] {
  const getSnapshot = useCallback(() => getChromeConditions(topic), [topic])
  return useSyncExternalStore(subscribeChromeConditions, getSnapshot, getSnapshot)
}

/** The highest severity true for a topic, or null when the topic is silent.
 * A button uses this to go red on 'severe'. */
export function useChromeConditionSeverity(topic: ConditionTopic): ConditionSeverity | null {
  const getSnapshot = useCallback(() => getChromeConditionSeverity(topic), [topic])
  return useSyncExternalStore(subscribeChromeConditions, getSnapshot, getSnapshot)
}

/** The class a corner button adds when it is carrying a severe condition. */
export function chromeConditionClass(severity: ConditionSeverity | null): string {
  return severity === 'severe' ? ' chrome-condition-severe' : ''
}
