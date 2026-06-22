// The introspection poke — the one short thing the disposition bot says.
//
// This is NOT a detector. The bot does not inspect the turn, match a regex, or
// judge anything. When an agent's turn ends and Skip is AWAY, the bot sends this
// one blunt line and the AGENT introspects. A "wrong" poke is cheap — the agent
// double-checks and moves on — which is why we can err toward prompting.
//
// PURPOSE (Skip's, verbatim reframe): the poke is a COMPLETENESS gut-check, not a
// testing one. The miss it targets is under-delivering — doing a fraction of the
// ask and making him micromanage ("I did 1/8, please clap"). It must NOT prescribe
// a verification METHOD (no "drive the browser" / "run the tests") — many changes
// don't need a browser, and backend work gets checked the backend way. The
// "check what your skills say to verify" clause is the method-neutral, lane-
// adaptive part: a math agent's skills say check the proof, a code agent's say
// check the real surface — so the one line fits every lane.
export const POKE = `Did you do the whole thing you were asked — or just a piece of it? If you think you're done, check what your skills say to verify.`

// The cwd seam is kept for shape, but the poke is now ONE universal string: the
// lane-adaptiveness lives in the agent's own skills, not in branched text.
export function pokeFor(_cwd) {
  return POKE
}
