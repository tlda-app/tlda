type SpatialWorldUiState = {
  hoveredNodeId: string | null
  selectedNodeId: string | null
}

let state: SpatialWorldUiState = {
  hoveredNodeId: null,
  selectedNodeId: null,
}

const listeners = new Set<() => void>()

function update(next: Partial<SpatialWorldUiState>) {
  const value = { ...state, ...next }
  if (
    value.hoveredNodeId === state.hoveredNodeId
    && value.selectedNodeId === state.selectedNodeId
  ) return
  state = value
  for (const listener of listeners) listener()
}

export function subscribeSpatialWorldUi(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSpatialWorldUi() {
  return state
}

export function hoverSpatialWorldNode(nodeId: string | null) {
  update({ hoveredNodeId: nodeId })
}

export function selectSpatialWorldNode(nodeId: string | null) {
  update({ selectedNodeId: nodeId })
}
