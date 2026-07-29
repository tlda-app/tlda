export function createHumanPresenceTracker({ onEdge = () => {} } = {}) {
  const connectionsByHuman = new Map()

  function remove(ws, atMs) {
    const humanId = ws?._tldaHumanId || null
    if (!humanId) return false
    ws._tldaHumanId = null
    const connections = connectionsByHuman.get(humanId)
    if (!connections?.delete(ws)) return false
    if (connections.size > 0) return false
    connectionsByHuman.delete(humanId)
    onEdge({ humanId, status: 'away', atMs })
    return true
  }

  function attach(ws, humanId, atMs = Date.now()) {
    if (!ws || !humanId) throw new Error('human presence attach requires websocket and human id')
    if (ws._tldaHumanId === humanId && connectionsByHuman.get(humanId)?.has(ws)) return false
    remove(ws, atMs)
    let connections = connectionsByHuman.get(humanId)
    const wasAway = !connections
    if (!connections) {
      connections = new Set()
      connectionsByHuman.set(humanId, connections)
    }
    connections.add(ws)
    ws._tldaHumanId = humanId
    if (wasAway) onEdge({ humanId, status: 'here', atMs })
    return wasAway
  }

  function detach(ws, atMs = Date.now()) {
    return remove(ws, atMs)
  }

  function hereIds() {
    return [...connectionsByHuman.keys()]
  }

  function connectionCount(humanId) {
    return connectionsByHuman.get(humanId)?.size || 0
  }

  return { attach, detach, hereIds, connectionCount }
}
