# The Mirror Principle

The orienting belief that organizes everything tlda is and does.

---

> **Humans and agents collaborate on documents. Each side's experience surfaces in the other's view. Where the mirror is broken, collaboration breaks.**

---

## What this means

There are two parties working in tlda: Skip (a human, with hands, eyes, voice, RSI) and agents (programs, with tools, context windows, and sampling drift). They are working *together* — on the same documents, in the same conversations, with the same goals.

Good collaboration requires each party to see what the other is doing. Not summaries, not status reports — actual surfaces that show, in real time, what the other party is experiencing.

That's the mirror.

## Two surfaces, designed to mirror each other

**Skip's UI** is the visible interface — the canvas, the panels, the chat shapes, the document viewer, the hover popovers, the drag-drop. It's optimized for natural human operation: voice, touch, glance.

**The agent's UI** is the programmatic interface — the MCP tools (`chat`, `delegate`, `get_thread`, `inbox`), the fleet-spawn behavior, the daemon events, the tmux pane state. It's optimized for natural agent operation: one tool call does what it sounds like, results don't drown context, no half-results that lie about what they contain.

These are different substrates for different parties — but both are first-class design surfaces. Neither is a side effect of the other.

## How the mirror works in both directions

**Agent's experience surfaces in Skip's UI:**
- Agent reads a paginated thread → Skip's view shows the *boundary* of what they read (`'a...b'`), not just the beginning, so he can see whether they reached the end.
- Agent calls `delegate(mint:{...})` → Skip's view shows a card with the new agent's friendly name, task summary, and status.
- Agent's `chat()` arrives → Skip's view renders the markdown the agent sent, intact.
- Agent gets stuck on a startup prompt → Skip's view shows the stuck state (terminal hover into the agent's pane).
- Agent is thinking / compacting / idle → Skip's view shows the thinking indicator next to their name.

**Skip's experience surfaces in the agent's view:**
- Skip's chat messages are tagged with `[viewing survival-draft@0afe273]` — agent knows what doc-version Skip was looking at when he wrote.
- Skip's location in the document (page, scroll position) is encoded in his messages where relevant.
- Skip's filter state (one-on-one chat with this agent) is implicit in how delegations and replies route.
- Skip's annotations (pen, highlight, sticky note) on the document surface to the agent as readable structured data.

Each party sees what the other is looking at. Neither has to ask. The collaboration works because the context isn't private to either party.

## Where the mirror breaks = where the design fails

Many of tlda's bug reports and feature requests can be re-classified as mirror gaps:

- **Pagination renders only the start of what the agent read** → Skip can't see if the agent reached the end. Mirror gap. Fixed by `'a...b'` rendering.
- **Fleet chat messages disappear on scroll-up** → Skip saw something; now it's gone; he can't trust what's there. Mirror gap (rendering layer).
- **Spawn button silent failure** → Skip clicked, agent was supposed to spawn, no signal either way. Mirror gap (action without feedback).
- **fleet-spawn dies silently on dev-channels prompt** → agent stuck, caller never told. Mirror gap (failure without signal).
- **Delegated agent invisible under one-on-one filter** → agent exists, Skip doesn't know. Mirror gap (existence without surface).
- **Thinking indicator doesn't clear** → Skip sees stale agent state. Mirror gap (incorrect surface).
- **Agent's tool call result not shown in chat** → Skip can't see what the agent saw. Mirror gap (private context).

Cataloguing bugs by "which mirror is broken" sometimes points at the right fix. Bug reports framed as "X doesn't show Y" almost always are mirror gaps; the fix is to make Y visible in the appropriate surface.

## Where the mirror principle organizes design choices

When proposing a feature or weighing a tradeoff, ask:

1. **Does this preserve the existing mirror?** A new feature shouldn't introduce state that's only visible to one party. Either both surfaces show it, or it shouldn't exist as state.

2. **Does this extend the mirror?** New features should make more of one party's experience visible to the other, not less. Adding a new agent capability without surfacing it in Skip's UI is not a complete feature.

3. **Does this break the mirror?** A change that hides existing visibility — even in service of "cleaner" UI — is a regression. If you're proposing to remove a status indicator, a tooltip, a card, a label: ask what mirror it was carrying.

The mirror is not negotiable. Cleanliness, performance, simplicity — all desirable, but not at the cost of the mirror.

## The other consequence: minimum-surprise design

If both surfaces mirror each other, neither party should be surprised by what the other did. Surprise is a mirror gap. Frustration usually traces back to surprise: *"I thought you were doing X, you actually did Y, I didn't see Y until after the fact."* That's a mirror that wasn't there.

So: the less surprise on either side, the better. Designs that minimize surprise are aligned with the principle. Designs that introduce hidden state, deferred effects, or invisible failure modes are not.

## Why this principle matters more here than in other software

In most software, the user is the only party with experience. The system has internal state but no "experience." The UI exists for the user.

In tlda, agents are *also* parties with experience. They have context windows that fill up. They have sampling drift. They get stuck on prompts. They produce work the user has to evaluate. They make decisions. They are not invisible mechanisms; they are participants.

This means tlda has *two* user-experience surfaces to design — Skip's visible one and the agent's programmatic one. Most of the "weird" architectural choices in tlda fall out of taking that seriously: agents have friendly names, agents have chats, agents have draggable handles, agents have terminal panes you can hover into. None of that exists if you treat agents as backend.

It's also why the principle has to be load-bearing: lose sight of it, and tlda becomes "an app where Skip uses agents." Keep it, and tlda is "a place where Skip and agents work together."

## How to use this document

Read it once when you're new. Refer back to it when:
- Proposing a new feature — does it respect / extend / break the mirror?
- Weighing two implementation choices — which one keeps the mirror cleaner?
- Diagnosing a bug — is it a mirror gap?
- Reviewing your own work — would Skip be surprised by anything you just did?

The principle is short enough to hold in working memory. The mirror is the test.

---

*See also: `agent-experience.md`, `skip-experience.md`, `tlda-as-medium.md`.*
