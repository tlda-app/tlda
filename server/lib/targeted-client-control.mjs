export function reloadHumanFleetClients(clients, humanId, payload = {}) {
  if (typeof humanId !== 'string' || !humanId.startsWith('fleet:')) {
    throw new Error('humanId must be a fleet: human identity')
  }

  const message = JSON.stringify({
    type: 'reload',
    timestamp: Date.now(),
    ...payload,
  })
  let matched = 0
  let sent = 0

  for (const ws of clients) {
    if (ws?._tldaHumanId !== humanId) continue
    matched += 1
    if (ws.readyState !== 1) continue
    ws.send(message)
    sent += 1
  }

  return { humanId, matched, sent }
}
