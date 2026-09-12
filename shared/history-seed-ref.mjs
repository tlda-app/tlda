export function gitDaemonNamespace(value) {
  const part = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '-')
  if (!part || part.startsWith('.') || part.endsWith('.')) throw new Error(`invalid daemon namespace: ${value}`)
  return part
}

export function historySeedRef({ daemonId, revision }) {
  if (!daemonId || !/^[0-9a-f]{40,64}$/.test(revision || '')) throw new Error('daemonId and revision are required')
  return `refs/tlda/history-seeds/${gitDaemonNamespace(daemonId)}/${revision}`
}

export function proposalRef({ daemonId, branch, revision }) {
  if (!daemonId || !branch || !/^[0-9a-f]{40,64}$/.test(revision || '')) throw new Error('daemonId, branch, and revision are required')
  return `refs/tlda/proposals/${gitDaemonNamespace(daemonId)}/${branch}/${revision}`
}

export function parseProposalRef(ref, daemonId = null) {
  const root = 'refs/tlda/proposals/'
  if (!ref.startsWith(root)) return null
  let rest = ref.slice(root.length)
  let resolvedDaemon = daemonId
  if (daemonId) {
    const daemonPrefix = `${gitDaemonNamespace(daemonId)}/`
    if (!rest.startsWith(daemonPrefix)) return null
    rest = rest.slice(daemonPrefix.length)
  } else {
    const firstSlash = rest.indexOf('/')
    if (firstSlash <= 0) return null
    resolvedDaemon = decodeURIComponent(rest.slice(0, firstSlash))
    rest = rest.slice(firstSlash + 1)
  }
  const slash = rest.lastIndexOf('/')
  if (slash <= 0) return null
  const branch = rest.slice(0, slash)
  const revision = rest.slice(slash + 1)
  if (!branch || !/^[0-9a-f]{40,64}$/.test(revision)) return null
  return { daemonId: resolvedDaemon, branch, revision }
}

export function parseDaemonProposalRef(ref, daemonKey) {
  return parseProposalRef(ref, daemonKey)
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
