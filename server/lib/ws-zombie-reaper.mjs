const DEFAULT_CONCURRENCY = 8

async function mapConcurrent(items, concurrency, visit) {
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await visit(item)
    }
  })
  await Promise.all(workers)
}

export async function reapZombieSockets({
  trackedWs,
  now = Date.now(),
  thresholdMs,
  findMachine,
  killOrphan,
  log = () => {},
  concurrency = DEFAULT_CONCURRENCY,
}) {
  const zombies = []
  let activeCount = 0
  for (const ws of trackedWs) {
    if (ws.readyState !== 1) continue
    const idleMs = now - ws._wsLastInputAt
    if (idleMs > thresholdMs) zombies.push({ ws, idleMs })
    else activeCount++
  }

  await mapConcurrent(zombies, concurrency, async ({ ws, idleMs }) => {
    const machineId = findMachine(ws._wsRemoteAddr)
    if (!machineId) {
      log({ ws, idleMs, outcome: 'no-daemon' })
      return
    }
    try {
      const result = await killOrphan(machineId, ws)
      const terminal = result?.killed || result?.reason?.startsWith('no process holds port ')
      if (terminal) {
        // A successful kill and an already-absent process are both terminal.
        // Drop the server-side half immediately so it cannot be retried by the
        // next sweep even if ws emits its close event asynchronously.
        trackedWs.delete(ws)
        ws.terminate()
      }
      log({ ws, idleMs, outcome: result?.killed ? 'killed' : 'no-kill', result })
    } catch (error) {
      log({ ws, idleMs, outcome: 'error', error })
    }
  })

  return { activeCount, zombieCount: zombies.length }
}
