export function gitDaemonNamespace(value) {
  const part = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '-')
  if (!part || part.startsWith('.') || part.endsWith('.')) throw new Error(`invalid daemon namespace: ${value}`)
  return part
}

export function historySeedRef({ daemonId, revision }) {
  if (!daemonId || !/^[0-9a-f]{40,64}$/.test(revision || '')) throw new Error('daemonId and revision are required')
  return `refs/tlda/history-seeds/${gitDaemonNamespace(daemonId)}/${revision}`
}

export function parseHistorySeedRef(ref, daemonId = null) {
  const root = 'refs/tlda/history-seeds/'
  if (!ref.startsWith(root)) return null
  let rest = ref.slice(root.length)
  let resolvedDaemon = daemonId
  if (daemonId) {
    const prefix = `${gitDaemonNamespace(daemonId)}/`
    if (!rest.startsWith(prefix)) return null
    rest = rest.slice(prefix.length)
  } else {
    const slash = rest.indexOf('/')
    if (slash <= 0) return null
    resolvedDaemon = rest.slice(0, slash)
    rest = rest.slice(slash + 1)
  }
  if (!/^[0-9a-f]{40,64}$/.test(rest)) return null
  return { daemonId: resolvedDaemon, revision: rest }
}
