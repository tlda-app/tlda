export function spawnCallerId(ws, msg = {}) {
  return ws?._tldaAgentId ||
    ws?._tldaHumanId ||
    msg?.fleet_operation?.sender ||
    msg?.from ||
    null
}
