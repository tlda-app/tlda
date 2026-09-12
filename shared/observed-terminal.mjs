// What the system saw on an agent's terminal, in the shape Skip specified:
//
//   "say 'I, tlda, looked at their terminal and it looked like this'"
//   "[the results of tmux read-pane]"
//   "it looked like this at [this time]. It could have changed... say [this] to
//    look again"
//   "if the app doesn't know how to fix it, at least report the info it has so
//    it's easy for the agent"
//
// **The inability is what makes the report load-bearing.** If the system could
// fix it, nobody would need to be told; it is precisely the cases it cannot
// resolve that must arrive carrying what it knows. An error that names only
// what did not work sends the reader off to invent a remedy -- the same defect
// as a runbook saying that killing the client does not stop a deploy and never
// saying what does.
//
// This lives in `shared/` because two processes emit it: the MCP tool layer
// (`lifecycle wake`) and the server (the mint did-not-log-in notice), which
// cannot reach each other. Both had the same three-part message to compose, and
// one of them would otherwise have been a copy.
//
// The particular failure it was written for: an agent whose kickoff sits unsent
// in its composer has a live process, a live tmux session, and has produced no
// turn. From outside that reads as "the mint failed", "the agent will not wake",
// or "hibernating with unknown activity" -- three names for one cause, none of
// which points at it. The pane is obvious on sight and opaque as a description.

export function windowTail(output, n = 20) {
  return String(output ?? '').split('\n').slice(-n).join('\n')
}

// `label` is the agent's friendly name -- what the reader would type -- never an
// id. `observedAt` is required in spirit: an observation with no timestamp is
// indistinguishable from a live one and gets acted on as live, so the caller
// passing nothing gets "now" rather than a report with the time left off.
export function observedTerminalReport(label, pane, observedAt, lines = 20) {
  const when = observedAt || new Date().toISOString()
  return [
    `I, tlda, looked at ${label}'s terminal at ${when} and it looked like this:`,
    '',
    '```',
    windowTail(pane, lines),
    '```',
    '',
    `That is what the terminal held at ${when}. It could have changed since.`,
    `To look again, say: terminal(agent: "${label}")`,
  ].join('\n')
}
