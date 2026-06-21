// The introspection poke — the one thing the disposition bot says.
//
// This is NOT a detector. The bot does not inspect the turn, match a regex, or
// judge anything. When an agent's turn ends and Skip isn't in the room, the bot
// sends this prompt and the AGENT introspects. A "wrong" poke is cheap — the
// agent double-checks and moves on — which is why we can err toward prompting.
//
// The text is grounded in Skip's ACTUAL recurring corrections, not invented
// checks or generic platitudes. The three questions are the three highest-
// leverage gates the disposition mine named (scratch/disposition-mine/
// TAXONOMY.md §"THREE triggers"), phrased in Skip's own terms from
// ~/.claude/CLAUDE.md:
//   1. did-the-actual-thing / no-weaseling   (CLAUDE.md "Do what was asked",
//      "No weaseling"; TAXONOMY B "his actual ask in his words")
//   2. verified-not-assumed / didn't-break-it (CLAUDE.md "Don't fabricate",
//      "Diagnose failures yourself"; TAXONOMY A "untouched surface", E "broke
//      it and moved on")
//   3. didn't-make-him-steer                  (CLAUDE.md self-service rule,
//      "Don't punt to Skip"; TAXONOMY C "made him come into the room")

export const GENERIC_POKE = `🪞 **Turn-end self-check — are you actually done?** Nobody's grading you; this is a 20-second look in the mirror before you walk away. Be honest:

1. **Did I do the thing Skip asked — or something easier I could argue was the thing?** If the ask was X and I delivered weaker-X, that's not done — narrow the claim honestly or go finish X. (And: was it *his* ask in *his* words, not the prior agents' frame?)
2. **Did I verify, or am I assuming?** If I called it fixed / explained *why* something happens without checking the surface Skip actually touches, I haven't checked. Did I confirm I didn't **break what already worked** — not just that my new thing works — with evidence that's conclusive, not read charitably?
3. **Am I making Skip steer?** No "reload and check," no punt, no wall-then-silence. If I'm handing him a condition, a re-spec, or "go see if it works" instead of a result he can act on in one read, the job's not finished — it's mine to finish.

If any answer is shaky, fix it before you call it done. If they're all solid, ignore this and carry on.`

// Seam for per-working-directory variants. v1 returns the one generic poke for
// every agent. Skip flagged that math agents have a DIFFERENT miss-set than app
// agents (papering a gap with `\text{}`, weaseling a quantifier, certifying a
// non-proof, notation drift) and that the poke should eventually be cwd-
// sensitive. The routing isn't built — this is where it goes: branch on `cwd`
// (e.g. a math worktree → a math-specific poke) and return the right text.
export function pokeFor(_cwd) {
  return GENERIC_POKE
}
