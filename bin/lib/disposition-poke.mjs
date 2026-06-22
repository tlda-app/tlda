// The introspection poke — the one short thing the disposition bot says.
//
// This is NOT a detector. The bot does not inspect the turn, match a regex, or
// judge anything. When an agent's turn ends and Skip is AWAY, the bot sends a
// short, pointed nudge and the AGENT introspects. A "wrong" poke is cheap — the
// agent double-checks and moves on — which is why we can err toward prompting.
//
// Two things shape the poke (Skip's calls):
//   - It is SHORT. Agents don't need a big checklist; a one-line gut-check does
//     the job (stop the premature "I did 1/8, please clap").
//   - It is LANE-AWARE. A math/writing agent and a code/app agent fail in
//     different ways, so asking "did you verify it in the browser?" of a proof
//     agent (or "is every quantifier honored?" of an app agent) is noise. The
//     bot looks up the poked agent's cwd and pokeFor(cwd) returns the variant
//     that fits that lane. Each variant is grounded in Skip's ACTUAL recurring
//     corrections (~/.claude/CLAUDE.md, scratch/disposition-mine/TAXONOMY.md),
//     not invented checks.

// Lane-neutral fallback (no cwd, or a dir we can't classify). Covers the three
// highest-leverage gates compactly: did-the-actual-thing, verified-not-assumed,
// didn't-make-him-steer.
export const GENERIC_POKE = `🪞 Before you walk away: did you do *the actual thing Skip asked* — his ask in his words, not a prior agent's frame — and verify it? If it's weaker-X you'd have to argue for, that's not done — finish it or say so plainly. And don't hand him a "go check it."`

// Math / writing agents: the proof-and-prose miss-set — papering a gap with a
// `\text{}` phrase, weaseling a quantifier, certifying a non-proof.
export const MATH_POKE = `🪞 Before you call it done: is every object actually *defined* (not a \`\\text{}\` phrase standing in for one), every quantifier honored (no quietly narrowing $\\forall f \\in L^2$ to bounded $f$), and the argument a real proof — not a non-proof you'd certify as correct? If a step is hand-waved, say so; don't dress the gap in prose.`

// Code / app agents: the build-and-ship miss-set — claiming "fixed" from reading
// the code instead of running it, breaking what already worked, punting the check.
export const CODE_POKE = `🪞 Before you call it done: did you *verify it on the real surface* — ran it / drove the browser, read the actual output — not just "the code looks right"? And did you confirm you didn't break what already worked, not only that your new thing works? If you're about to say "fixed" without evidence, it isn't yet.`

// A cwd in the app repos (tlda/fleet) is the code/app lane; any other dir under
// ~/work is a paper/proof (math/writing) lane. (Skip: math agents live in his
// paper/proof dirs, code/app agents in tlda/fleet.) The segment-prefix match
// catches sibling worktrees too — tlda-buildq, fleet-data, …/tlda/.worktrees/x.
const APP_DIR_RE = /\/(?:tlda|fleet)[^/]*(?:\/|$)/i
const WORK_DIR_RE = /\/work\//

// Route a poked agent's working directory to the right lane's poke. Unknown or
// unset cwd → the lane-neutral generic poke (safe default).
export function pokeFor(cwd) {
  if (!cwd || typeof cwd !== 'string') return GENERIC_POKE
  if (APP_DIR_RE.test(cwd)) return CODE_POKE
  if (WORK_DIR_RE.test(cwd)) return MATH_POKE
  return GENERIC_POKE
}
