// What a login frame takes delivery of. The return notice is agent mail:
// the parked notice if one is parked, else the away notice if the agent was
// genuinely away. The MCP channel logs in over its own socket to register
// for pushes and ignores everything in the reply — handing it the notice
// consumes the agent's mail into a transport log nobody reads (measured
// 2026-09-28: a wake announcement parked seconds earlier was consumed by the
// channel login, and the agent's tool login received nothing). The channel
// flags itself (`channel: true`); only the agent's own login takes
// delivery. Unflagged logins (older MCPs) are treated as agent logins.

export function loginReturnNoticeHandover({ pendingNotice = null, awayNotice = null, isChannelLogin = false } = {}) {
  if (isChannelLogin) return { notice: null, consume: false }
  if (pendingNotice) return { notice: pendingNotice, consume: true }
  if (awayNotice) return { notice: awayNotice, consume: false }
  return { notice: null, consume: false }
}
