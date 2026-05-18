# Agents Panel + Search Redesign — Design Doc

## Current State

### Agents Panel (FleetAgentsShape)
What it shows today:
- Table with columns: unread dot, Agent name, Seen, Task, Labels
- Alive agents at top, then collapsible "stale" and "dead" sections
- Footer: "N online · N stale" + spawn buttons (+S, +O)
- Health dots (tlda/fleet/sync) at bottom
- Agent names are draggable (create filter pills for chat)
- Label chips are draggable

**What's broken/missing:**
1. **No way to open an agent's chat** — clicking the name starts a drag, not a navigation. You can see an agent exists but can't read what they're saying without dragging a pill onto a chat shape.
2. **Stale agents hidden by default** — collapsed behind a toggle. "Making things invisible AND folded is redundant and hides information" (master-plan). Stale agents should be visible but dimmed — the fold should only apply to dead agents (246+ of them).
3. **Can't respawn stale agents** — only dead agents have respawn. Stale agents (>10min no heartbeat) are often just agents whose session ended but weren't marked dead. Should be respawnable too.
4. **Task text is truncated to 50 chars with no tooltip preview** — the `title` attr is set but you have to hover precisely. No quick way to see what an agent is actually doing.
5. **No spawn with task/name** — +S and +O just create blank agents. No way to spawn with a pre-set name or task from the panel.
6. **No last message preview** — you see "2m" in the Seen column but not what the agent last said or what they need.

### Search Shape (FleetSearchShape)
What it shows today:
- Search input with debounce
- Results show: timestamp, sender name, → recipient, and message text preview (truncated to 120 chars)
- Also shows matching shared docs
- Footer with result count

**What's broken/missing:**
1. **Results aren't clickable** — you see a message but can't jump to that point in the conversation. No navigation action on click.
2. **No filters** — can't filter by agent, by role (user/assistant), or by time range.
3. **No "Skip's messages" view** — can't aggregate all of Skip's messages across all threads. This is the #1 priority from master-plan: "so agents can read your specs before working."
4. **No message context** — search shows a single snippet. No way to see what came before/after without manually finding the conversation.

---

## Proposed Changes

### Agents Panel v2

**Layout change:** Replace the flat table with a card-style list. Each agent gets a compact card (2-3 lines) instead of a single table row.

```
┌─────────────────────────────────────────┐
│ Agents                           +S  +O │
├─────────────────────────────────────────┤
│ ● panel-redesign              now    ⟳  │
│   Agents panel + search usability re... │
│   "Got the task. Starting the de..."    │
│   [tlda]                                │
├─────────────────────────────────────────┤
│ ● distribution                 2m       │
│   (no task)                             │
│   "Build completed successfully"        │
│   [tlda]                                │
├─────────────────────────────────────────┤
│ ○ refactor-lead              15m     ⟳  │
│   Refactor fleet-data module            │
│   "Waiting for review"                  │
│   [balancing-act]                       │
╞═════════════════════════════════════════╡
│ ▸ dead (246)                            │
├─────────────────────────────────────────┤
│ ● tlda  ● fleet  ● sync                │
│ 3 online · 1 stale                      │
└─────────────────────────────────────────┘
```

**Key changes:**

1. **Click agent name → open/focus their chat.** Find existing FleetChatShape filtered to that agent, or create one. Drag-to-filter still works (pointerdown + move = drag, click without move = open chat).

2. **Stale agents inline, not collapsed.** Agents seen <10min ago = full opacity. 10-30min = dimmed (opacity 0.6). >30min = more dimmed (0.4). Only the "dead" section is collapsed. Stale agents show a ⟳ respawn button.

3. **Two-line agent card:**
   - Line 1: status dot + name + seen time + respawn button (if stale/dead)
   - Line 2: task title (or "no task") — full width, truncated with ellipsis
   - Line 3: last message preview — italic, lower opacity
   - Labels as small chips below

4. **Respawn for stale agents.** The ⟳ button appears on hover for stale agents (always visible for dead when expanded).

5. **Last message preview.** Show the agent's most recent chat message (truncated ~60 chars). This tells you at a glance whether they need attention ("Waiting for approval"), are working ("Running playwright tests..."), or finished ("Task complete, report at...").

**Data needed:** Last message per agent. Options:
- Add to SSE agent data (fleet server enriches agent list with last message)
- Fetch from search API on mount (one query per visible agent — bad)
- New fleet endpoint: `GET /api/agents/summary` returns agents + last message

Recommend: fleet server enriches the SSE agent stream with `last_message` field.

### Search v2

**Layout:**

```
┌─────────────────────────────────────────┐
│ 🔍 [search query.................]      │
│ [All ▾] [Any time ▾] [Skip only ☐]     │
├─────────────────────────────────────────┤
│ MESSAGES                                │
│                                         │
│ 10:23  panel-redesign → skip            │
│ Got the task. Starting the design pass  │
│ — reading the master plan, current...   │
│                                    ↗    │
│─────────────────────────────────────────│
│ 10:15  skip → historian                 │
│ yeah the search needs to show actual    │
│ message text. right now it's useless    │
│                                    ↗    │
│─────────────────────────────────────────│
│ 09:50  historian                        │
│ Completed audit of all fleet shapes...  │
│                                    ↗    │
├─────────────────────────────────────────┤
│ 24 results · 3 docs                     │
└─────────────────────────────────────────┘
```

**Key changes:**

1. **Clickable results with ↗ jump button.** Click a result → find or create a FleetChatShape filtered to that agent, scroll to that timestamp. The ↗ icon makes the action discoverable.

2. **Filter bar below search input:**
   - **Agent dropdown** — "All" or pick a specific agent. Populated from live agent list.
   - **Time range** — "Any time", "Today", "This week", "This month"
   - **"Skip only" toggle** — filters to `role: user` messages only. This is the "everything Skip said" feature. When active, aggregates across all threads.

3. **Richer result cards.** Each result shows:
   - Timestamp + sender (+ recipient if directed)
   - 2-3 lines of message text (not just 1 truncated line)
   - Subtle separator between results

4. **Context expansion.** Click the message body area (not the ↗) to expand and show 2-3 messages before/after for context. Uses the search API's `context` parameter (already supported by fleet's search_logs).

**Backend changes needed:**
- Search API needs `role` filter param (for "Skip only")
- Search API needs `before`/`after` time range params
- Search API needs `agent` filter param
- Need an endpoint or param to fetch messages around a specific timestamp for context expansion
- Need a way to tell FleetChatShape "scroll to timestamp X" — probably a Yjs signal or direct prop

### Jump-to-chat mechanism

Both panels need to navigate to a specific agent's chat at a specific point. Proposed approach:

1. Look for existing FleetChatShape on the current page filtered to the target agent
2. If found: scroll that shape's message list to the target timestamp, briefly highlight the message
3. If not found: create a new FleetChatShape next to the search/agents panel, filtered to the target agent, scrolled to the target timestamp

Implementation: add a `scrollToTimestamp` prop or Yjs signal on FleetChatShape. When set, the chat component scrolls to the nearest message and applies a brief highlight animation (yellow flash, 1s fade).

---

## What I'm NOT changing

- Health dots — they work fine
- Drag-to-filter — existing pill drag system is solid
- Label chips — work as designed
- Spawn buttons — keeping +S and +O, just might add name input

## Implementation order

1. **Agents panel v2** — card layout, click-to-open-chat, inline stale agents, last message preview
2. **Search v2 filters** — agent/time/role filter bar
3. **Jump-to-chat** — clickable results, scroll-to-timestamp in FleetChatShape
4. **Context expansion** — expand search results to show surrounding messages
5. **Backend enrichment** — last_message in agent SSE, search API filter params

## Questions for Skip

1. **Agent card height:** The 3-line card is taller than the current single row. With 8 alive agents that's ~200px vs ~80px. Is the extra density worth the information? Or should line 3 (last message) only show on hover?
2. **Search "Skip only" toggle vs. dedicated tab:** Should "Skip's messages" be a toggle in the filter bar, or a separate tab/mode in the search shape? The toggle is simpler. A tab could have a different default sort (chronological across all threads).
3. **Jump-to-chat behavior:** When clicking a search result, should it reuse an existing chat shape or always open a new one alongside the search? Reusing is cleaner but might be disorienting if the chat was showing a different conversation.
4. **Backend scope:** The fleet server changes (last_message enrichment, search filters) — should I implement those too, or coordinate with whoever owns the fleet server?
