// The one boundary between a changed daemon roster and activity extraction.
// Every transport shape (welcome replay, snapshot, delta) must cross it.
export function reconcileDaemonRoster({ agents, signature, reason, syncIdentityNames, syncIfRosterChanged, onChanged }) {
  syncIdentityNames(agents)
  return syncIfRosterChanged({ agents, signature, reason, onChanged })
}
