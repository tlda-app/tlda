# One query grammar: `search` and `thread` are two renderings of it {#spec}

**This is Skip's design, in his words, 2026-08-18. Build to the quotes, not to any
description of the symptom — including this document's headings.**

## His words

> `to:me` is not supposed to be implicit when you use `filter`

> `thread` filter is supposed to be like another view on search results; same query

> `thread agent` is supposed to be `filter: me <> agent`

> terminal messages from [me] have to read as chat in search and thread

## The design, stated once

1. **One query grammar.** The grammar is the only thing that filters.
2. **`search` and `thread` are two renderings of the same query** — `search` returns
   snippets, `thread` returns complete formatted messages in order. **The difference is
   presentation, not scope.**
3. **`thread(agent: X)` is sugar for `thread(filter: "me <> X")`.** It is not a second
   code path. Nothing else is implicit.

## Reproductions, run first-hand tonight by `chief-night`

**A. A former name returns zero instead of the agent's history.** `fleet:0a554e63` was
named `chief` when it did today's work and is now `solved-non-problems`. Same agent,
same id, same window, two names:

```
thread(filter: "skip <> chief",                since: "1d")  →   0 messages
thread(filter: "skip <> solved-non-problems",  since: "1d")  → 300+ messages
```

`roster(filter: "chief")` resolves the name and shows the row, so the selector is
known-good. **The zero is the read tool, not the world.** This is the query that made a
fresh chief report that a full day of a fired chief's work did not exist.

**B. The implicit `to:me` on `filter:`.** `thread(filter: "from:X")` is silently
becoming `from:X AND to:me`, which returns zero whenever X never wrote to the caller —
for a freshly minted agent, always. Verified by the advocate over the same window:

```
thread(filter: "from:fleet:0a554e63 | to:fleet:0a554e63")  → 806
thread(filter: "from:fleet:0a554e63")                      →   0
```

**C. His terminal input is not in either view.** He dictates into agent terminals, which
is most of his day. Those rows live in session JSONL under `~/.claude/projects` and
neither `search` nor `thread` reads them. `search(role: "user")` returns **agents' own
filed task reports**, not his input — checked row by row.

## Why this outranks the rest of the list

Every empty result tonight came from one of the three above, and **each returned zero
rather than an error**, which is indistinguishable from a quiet world. Skip spent the day
asking where his requests were while the tools that hold them reported nothing. Three
agents, including two chiefs, concluded absence from a query that had been quietly
narrowed.

## The test, as an identity rather than three behaviours

For a set of selectors, assert these cover **the same event ids**:

```
thread(agent: X)   ≡   thread(filter: "me <> X")   ≡   search(query: "me <> X")
```

**Any pair disagreeing is this bug, whatever the surface.** Include a selector naming an
agent by a name it no longer holds, and one naming it by id.

**Do not fix B alone and stop.** Removing the implicit `to:me` from `filter` treats one
symptom of two views drifting apart. His statement is that they are the same query, so
the fix is that they share it.

## Boundaries

- A name is a pointer and the id is the address; **membership is lexical** — who held the
  name at the time of the event, not who holds it now. The row rendering already carries
  both (`chief fleet:0a554e63 →now:solved-non-problems`), so the data is there.
- Do not add a compatibility shim or a second path. This repo does not keep them.
- Verify over the wire the feature crosses. Both ends called from one process proves
  neither.
