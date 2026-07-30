import type { AutocompleteState } from '@algolia/autocomplete-core'

export type SearchAutocompleteStatus = 'closed' | 'open'

export type SearchAutocompleteToken = {
  start: number
  end: number
  text: string
  key: string | null
  value: string
}

export type SearchAutocompleteSuggestion = {
  id: string
  label: string
  insert: string
  kind: 'field' | 'agent' | 'label' | 'type' | 'role' | 'time' | 'project' | 'operator'
  detail?: string
}

export type SearchAutocompleteViewState = {
  status: SearchAutocompleteStatus
  query: string
  cursor: number
  token: SearchAutocompleteToken
  suggestions: SearchAutocompleteSuggestion[]
  highlightedIndex: number
}

export type SearchAutocompleteContext = {
  agents?: Array<{ id?: string; friendly_name?: string; labels?: string[] }>
  projects?: string[]
  currentProject?: string
}

const FIELD_KEYS = ['from', 'to', 'agent', 'type', 'since', 'before', 'after', 'role']
const AGENT_KEYS = new Set(['from', 'to', 'agent'])
const TIME_KEYS = new Set(['since', 'before', 'after'])
const EVENT_TYPES = ['chat', 'delegate', 'task_done', 'report', 'lifecycle']
const ROLES = ['user', 'assistant', 'chat', 'delegate', 'task_done']
const TIME_VALUES = ['today', 'yesterday', '1h', '4h', '1d', '1w']
const LOGICAL_OPERATORS: SearchAutocompleteSuggestion[] = [
  { id: 'operator:and', label: '&', insert: '& ', kind: 'operator', detail: 'AND' },
  { id: 'operator:or', label: '|', insert: '| ', kind: 'operator', detail: 'OR' },
  { id: 'operator:not', label: '!', insert: '! ', kind: 'operator', detail: 'NOT' },
  { id: 'operator:open-paren', label: '(', insert: '( ', kind: 'operator', detail: 'group' },
  { id: 'operator:close-paren', label: ')', insert: ') ', kind: 'operator', detail: 'group' },
]

export const SEARCH_AUTOCOMPLETE_EMPTY_TOKEN: SearchAutocompleteToken = {
  start: 0,
  end: 0,
  text: '',
  key: null,
  value: '',
}

export const SEARCH_AUTOCOMPLETE_INITIAL_VIEW_STATE: SearchAutocompleteViewState = {
  status: 'closed',
  query: '',
  cursor: 0,
  token: SEARCH_AUTOCOMPLETE_EMPTY_TOKEN,
  suggestions: [],
  highlightedIndex: -1,
}

export function searchAutocompleteViewState(
  state: AutocompleteState<SearchAutocompleteSuggestion>,
  cursor: number,
): SearchAutocompleteViewState {
  const suggestions = state.collections.flatMap((collection) => collection.items)
  const open = state.isOpen && suggestions.length > 0
  return {
    status: open ? 'open' : 'closed',
    query: state.query,
    cursor,
    token: activeSearchAutocompleteToken(state.query, cursor),
    suggestions,
    highlightedIndex: open && state.activeItemId !== null ? state.activeItemId : -1,
  }
}

export function activeSearchAutocompleteToken(query: string, cursor: number): SearchAutocompleteToken {
  const safeCursor = Math.max(0, Math.min(cursor, query.length))
  let start = safeCursor
  while (start > 0 && !/\s/.test(query[start - 1])) start--
  let end = safeCursor
  while (end < query.length && !/\s/.test(query[end])) end++
  const text = query.slice(start, end)
  const colon = text.indexOf(':')
  const key = colon > 0 ? text.slice(0, colon).toLowerCase() : null
  const value = colon > 0 ? text.slice(colon + 1) : text
  return { start, end, text, key, value }
}

export function applySearchAutocompleteSuggestion(
  query: string,
  token: SearchAutocompleteToken,
  suggestion: SearchAutocompleteSuggestion,
): { query: string; cursor: number } {
  const suffixStart = suggestion.insert.endsWith(' ') && /\s/.test(query[token.end] || '')
    ? token.end + 1
    : token.end
  const next = `${query.slice(0, token.start)}${suggestion.insert}${query.slice(suffixStart)}`
  return { query: next, cursor: token.start + suggestion.insert.length }
}

export function searchAutocompleteSuggestions(
  query: string,
  cursor: number,
  context: SearchAutocompleteContext = {},
): SearchAutocompleteSuggestion[] {
  const token = activeSearchAutocompleteToken(query, cursor)
  const text = token.text.toLowerCase()
  const value = token.value.toLowerCase()
  const suggestions: SearchAutocompleteSuggestion[] = []

  if (!token.key) {
    if (hasCompletedOperandBefore(query, token.start)) {
      for (const operator of LOGICAL_OPERATORS) {
        if (!text || operator.label.startsWith(text)) {
          suggestions.push(operator)
        }
      }
    }
    for (const key of FIELD_KEYS) {
      const label = `${key}:`
      if (!text || label.startsWith(text)) {
        suggestions.push({ id: `field:${key}`, label, insert: label, kind: 'field', detail: 'filter' })
      }
    }
    for (const project of context.projects || []) {
      if (!text || project.toLowerCase().startsWith(text)) {
        suggestions.push({ id: `project:${project}`, label: project, insert: projectWithSpace(project), kind: 'project', detail: 'project text' })
      }
    }
    return suggestions.slice(0, 8)
  }

  if (AGENT_KEYS.has(token.key)) {
    for (const name of agentNames(context.agents || [])) {
      if (!value || name.toLowerCase().includes(value)) {
        suggestions.push(agentValueSuggestion(token.key, name, 'agent'))
      }
    }
    for (const label of agentLabels(context.agents || [])) {
      if (!value || label.toLowerCase().includes(value)) {
        suggestions.push(agentValueSuggestion(token.key, label, 'label'))
      }
    }
  } else if (token.key === 'type') {
    for (const type of EVENT_TYPES) if (!value || type.startsWith(value)) {
      suggestions.push({ id: `type:${type}`, label: type, insert: `${token.key}:${type} `, kind: 'type', detail: 'event type' })
    }
  } else if (token.key === 'role') {
    for (const role of ROLES) if (!value || role.startsWith(value)) {
      suggestions.push({ id: `role:${role}`, label: role, insert: `${token.key}:${role} `, kind: 'role', detail: 'result role' })
    }
  } else if (TIME_KEYS.has(token.key)) {
    for (const time of TIME_VALUES) if (!value || time.startsWith(value)) {
      suggestions.push({ id: `${token.key}:${time}`, label: time, insert: `${token.key}:${time} `, kind: 'time', detail: 'time filter' })
    }
  }

  return suggestions.slice(0, 8)
}

function agentValueSuggestion(key: string, value: string, kind: 'agent' | 'label'): SearchAutocompleteSuggestion {
  return {
    id: `${kind}:${key}:${value}`,
    label: value,
    insert: `${key}:${value} `,
    kind,
    detail: kind === 'agent' ? 'agent' : 'label',
  }
}

function agentNames(agents: Array<{ id?: string; friendly_name?: string }>): string[] {
  const names = new Set<string>(['me'])
  for (const agent of agents) {
    const friendly = String(agent.friendly_name || '').trim()
    const id = String(agent.id || '').replace(/^fleet:/, '').trim()
    if (friendly) names.add(friendly)
    else if (id) names.add(id)
  }
  return [...names].sort((a, b) => {
    if (a === 'me') return -1
    if (b === 'me') return 1
    return a.localeCompare(b)
  })
}

function hasCompletedOperandBefore(query: string, tokenStart: number) {
  const prefix = query.slice(0, tokenStart).trim()
  if (!prefix) return false
  const last = prefix.match(/\S+$/)?.[0] || ''
  if (!last || last === '&' || last.endsWith(':')) return false
  return true
}

function agentLabels(agents: Array<{ labels?: string[] }>): string[] {
  const labels = new Set<string>()
  for (const agent of agents) {
    for (const label of agent.labels || []) {
      if (label) labels.add(label)
    }
  }
  return [...labels].sort((a, b) => a.localeCompare(b))
}

function projectWithSpace(project: string) {
  return /\s$/.test(project) ? project : `${project} `
}
