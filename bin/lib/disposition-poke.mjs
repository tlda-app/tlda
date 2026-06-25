// The introspection poke — the one short thing the disposition bot says.
//
// This is NOT a detector. The bot does not inspect the turn, match a regex, or
// judge anything. When an agent's turn ends and Skip is AWAY, the bot sends this
// one blunt line and the AGENT introspects. A "wrong" poke is cheap — the agent
// double-checks and moves on — which is why we can err toward prompting.
//
// PURPOSE (Skip's, verbatim reframe): the poke is a NEXT-ACTION gut-check, not a
// status request. The miss it targets is stopping at a defensible partial answer
// and making him re-enter the room to name the next move. It must NOT prescribe a
// verification METHOD (no "drive the browser" / "run the tests") — many changes
// don't need a browser, and backend work gets checked the backend way. The agent
// must identify the next unresolved action it can do itself; if one exists, the
// correct response is to do it before reporting.
export const POKE = `Before you report status or call this done: what is the next unresolved action you can do yourself? If one exists, do it now.`

// The cwd seam is kept for shape, but the poke is now ONE universal string: the
// lane-adaptiveness lives in the agent's own skills, not in branched text.
export function pokeFor(_cwd) {
  return POKE
}
