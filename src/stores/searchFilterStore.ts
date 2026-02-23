/**
 * Search visibility filter store.
 * When active, holds a Set of shape IDs that match the current search.
 * Notes not in the set render dimmed on canvas.
 * null = no filter (all visible).
 */

let filterSet: Set<string> | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

export function subscribeSearchFilter(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getSearchFilter(): Set<string> | null {
  return filterSet
}

export function setSearchFilter(ids: Set<string> | null) {
  filterSet = ids
  notify()
}

export function clearSearchFilter() {
  if (filterSet === null) return
  filterSet = null
  notify()
}
