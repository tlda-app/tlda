# Naming errata

Names in this codebase that are wrong, with what they actually mean. Skip asked for this list
on 2026-08-12 after hitting one of them:

> that's just, like, stupid fucking naming. Right? And it's like, should we fix that? We should
> — if we don't fix that, we should at least add it to a list of things that are fucking bad,
> like naming errata.

**The list exists because a rename is often the wrong thing to do right now and the knowledge is
always worth having now.** A rename touching a dozen call sites in a live path is a real change
with real risk; writing down that the name lies costs nothing and stops the next person
inheriting the confusion.

**What belongs here:** a name that misdescribes what the thing does, collapses distinctions the
system makes elsewhere, or understates what it costs to call. **What does not:** a name someone
merely dislikes, or a name that is simply old — see `AGENTS.md` §"Notation is borrowed, and so
is its meaning" for how naming decisions are actually made here.

**Fixing one is always allowed.** Delete its entry in the same commit.

---

## `markAgentNotAlive` — `server/unified-server.mjs:559`

**What it does:** records that an agent stopped being reachable, drops it from the live set,
writes its runtime state as hibernating, and **discards its unsent source edits and ephemeral
state**.

**Three things wrong with the name:**

**It is a negation where the system has words.** Runtime status is `awake`, `hibernating`,
`dead` — see [Identity and labeling](identity-and-labeling.md). "Not alive" names none of them;
it names the absence of the first.

**It is called for three different situations and flattens them.** `dead`, `wedged`, and
`unknown` all route through it (`:605-606`). **Unknown is not a state of the agent — it is a
state of our knowledge of the agent**, and the name cannot distinguish them. The `detail.unknown`
flag carries that distinction instead, which means the caller has to know to look.

**And `mark…` understates it.** It marks, and it also deletes: `clearSourceEditsForAgent` throws
away that agent's in-flight source edits. **A name that reads as bookkeeping gets called from a
new place by someone who believes it is harmless.**

**A better name would say which of the three it is and that it discards work.** Splitting the
unknown case out is probably the bigger half of the fix.
