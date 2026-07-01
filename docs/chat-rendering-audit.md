# Fleet Chat Rendering Audit

## How It Works Now

Fleet chat currently mixes three different update classes in one React shape:

- Message events come through `useFleetEvents`, which is backed by `live-store`
  and gives the chat a maintained filtered event view.
- Agent state comes through the roster path. Historically, filtered chat code
  still derived several local values by scanning or serializing the whole roster.
- Per-agent status rows are computed from thinking, compacting, context, and
  hibernating state, then rendered above the message list.

That mix is why a one-agent chat can flicker while idle. The user's visible
message set is already filtered, but unrelated global fleet churn can still
invalidate chat render state.

Known leak points from the audit:

- `statusTargetIds`: previously called `resolveFilter(dnfFilter)` with the whole
  `agents` array as a memo dependency. Any unrelated roster/status event caused
  recomputation and chat render work.
- `ctxRenderKey`: previously serialized `agents.map(...)` for the whole roster,
  so any unrelated agent rename/status metadata change invalidated message render
  caches for a filtered chat.
- `isImpossibleFilter`: still scans the whole roster to decide whether a filter
  has any possible match.
- `resolveToFleetIds` / `resolveToFleetId`: still scan the whole roster for
  label-to-id resolution used by UI interactions.
- `FleetIconPill` alive count: still derives count from the full roster in the
  pill render path.

There is a separate rendering issue in the status ticker path: elapsed time and
status-edge changes can still cause more of the chat tree to re-render than the
single ticker/status leaf that changed. That is not the same bug as roster
churn, but it has the same visible symptom: idle chat chrome redraws while the
message list did not semantically change.

## Target

The target model is event-based and isolated:

- A message event updates only the maintained filtered message view and the
  virtualized list items that actually changed.
- A target agent status event updates only that agent's status row/ticker.
- A ticker tick updates only the ticker text leaf, not the chat shape, message
  list, render cache, or scroll machinery.
- Unrelated global fleet churn re-renders nothing in the user's filtered chat.

The mechanism is the existing `shared/live-store.ts` abstraction:

- Maintain indexes and keyed views for data that changes globally.
- Subscribe each chat to the smallest view matching its filter.
- Make render keys from filtered-view participants and stable scalars, never
  from full-roster serialization.
- Keep exact-name identity/filter semantics. Display decoration and search are
  separate concerns.

## Ordered Path

1. **P0: filtered status targets and render-key scope. Done.**
   `statusTargetIds` and filtered `hibernatingAgents` now come from the
   maintained agent live-store/index path, and filtered chats build
   `ctxRenderKey` from filtered-view participants rather than the whole roster.
   Live-scale proof: unrelated status churn left the one-agent filtered snapshot
   key unchanged; target status churn changed it.

2. **Move `isImpossibleFilter` onto the maintained agent index.**
   This should answer "does this filter currently have a possible agent match?"
   from indexed labels, not from `agents.some(...)` over the full roster.

3. **Move `resolveToFleetIds` / `resolveToFleetId` onto the maintained agent
   index.**
   Drag/drop and composer target resolution should read indexed label buckets,
   preserving exact-name semantics and the existing live/dead namesake rule.

4. **Move `FleetIconPill` counts onto maintained counts/views.**
   The pill should subscribe to a stable count source rather than filtering the
   full roster during render.

5. **Audit remaining filtered-chat roster dependencies.**
   Search for `agents` in `FleetChatShape.tsx` and separate unavoidable
   display/context reads from anything that can invalidate message rendering.
   Each remaining dependency should be either scoped to filtered participants or
   justified as a global/unfiltered-chat path.

6. **Isolate ticker/status rendering.**
   Status rows should be memoized by agent id and state. `ElapsedTime` should
   remain a leaf-local tick, and the parent chat/list/render-cache path should
   not rebuild merely because one visible elapsed-time string changed.

7. **Browser proof for each step.**
   The proof shape is always the same: a default one-agent filtered chat sitting
   idle, then unrelated global churn. The passing condition is zero render-count
   delta and zero DOM mutation inside that chat. A target-agent status/message
   change must still update the relevant row or message.
