import assert from 'node:assert/strict'
import autocompleteCore from '@algolia/autocomplete-core'

import {
  activeSearchAutocompleteToken,
  applySearchAutocompleteSuggestion,
  searchAutocompleteViewState,
  searchAutocompleteSuggestions,
} from '../src/fleet/search-autocomplete.ts'

assert.deepEqual(activeSearchAutocompleteToken('hello from:sk before:1d', 12), {
  start: 6,
  end: 13,
  text: 'from:sk',
  key: 'from',
  value: 'sk',
})

const suggestions = searchAutocompleteSuggestions('hello from:sk before:1d', 12, {
  agents: [
    { id: 'fleet:skip', friendly_name: 'skip', labels: ['project:tlda'] },
    { id: 'fleet:feature-manager', friendly_name: 'feature-manager', labels: ['manager'] },
  ],
})
assert.equal(suggestions[0].insert, 'from:skip ')

const applied = applySearchAutocompleteSuggestion(
  'hello from:sk before:1d',
  activeSearchAutocompleteToken('hello from:sk before:1d', 12),
  suggestions[0],
)
assert.equal(applied.query, 'hello from:skip before:1d')
assert.equal(applied.cursor, 'hello from:skip '.length)

let latestState = null
const autocomplete = autocompleteCore.createAutocomplete({
  id: 'fleet-search-test',
  environment: {
    ...globalThis,
    document: {
      activeElement: null,
      createElement: () => ({ setAttribute() {} }),
      querySelector: () => null,
    },
    navigator: { userAgent: 'node' },
  },
  defaultActiveItemId: 0,
  openOnFocus: true,
  onStateChange({ state }) {
    latestState = state
  },
  shouldPanelOpen({ state }) {
    return state.collections.some((collection) => collection.items.length > 0)
  },
  getSources({ query }) {
    return [
      {
        sourceId: 'fleet-search-suggestions',
        getItems() {
          return searchAutocompleteSuggestions(query, 2)
        },
        getItemInputValue({ item }) {
          return applySearchAutocompleteSuggestion(query, activeSearchAutocompleteToken(query, 2), item).query
        },
      },
    ]
  },
})

autocomplete.setQuery('fr')
autocomplete.setIsOpen(true)
await autocomplete.refresh()
assert.equal(latestState.isOpen, true)
assert.equal(latestState.activeItemId, 0)
const viewState = searchAutocompleteViewState(latestState, 2)
assert.equal(viewState.status, 'open')
assert.equal(viewState.suggestions[0].insert, 'from:')

autocomplete.setActiveItemId(1)
assert.equal(latestState.activeItemId, 1)
autocomplete.setIsOpen(false)
assert.equal(searchAutocompleteViewState(latestState, 2).status, 'closed')

const typeValue = searchAutocompleteSuggestions('type:de', 7)
assert.equal(typeValue[0].insert, 'type:delegate ')

console.log('fleet search autocomplete state machine ok')
