# Chat rendering and scrolling

This document describes the current fleet-chat panel implementation. Standalone
chat surfaces use `src/fleet/StandaloneChatPanel.tsx`, which mounts the same chat
component with an index editor rather than maintaining a second renderer.

## Rendering pipeline

Fleet chat events are converted to rendered row data before React places them in
the panel. Each visible row has a stable key. Stable keys allow the panel to keep
the same content in view while history is prepended, messages are amended, or a
row changes height.

Some row bodies remain dynamic after their initial render. Images can finish
loading, activity output can grow, and thread or tool-call details can expand.
The list therefore measures rendered rows and updates its height map rather than
assuming a fixed row height.

## Anchored list

The panel uses the anchored list in `src/shapes/FleetChatShape.tsx`. It does not
use `react-virtuoso`.

The browser scroll element contains a tall `.fleet-chat-scroll-sensor`. Inside
the sensor, `.fleet-chat-anchored-slice` is translated to the current model
position, and only the rows intersecting the viewport plus an overscan region
are mounted. The important positions are:

- `sensorTopRef`: the browser scroll element's position within the fixed sensor;
- `modelTopRef`: the logical position within the complete chat history;
- the height map: measured or estimated row heights used to locate each item.

`recenterSensor` moves the browser position back to the sensor midpoint before
it reaches either edge. Recentering preserves `modelTopRef`, so it extends the
usable scroll range without changing which chat content is visible.

## Tail mode and reader mode

Tail mode follows the newest row. Reader mode preserves the reader's logical
position while new events arrive or rendered rows change height.

A user gesture can leave tail mode. Content arrival and measurement changes do
not. Returning to the tail explicitly, or settling at the actual end of the
list, restores tail mode.

While pointer, touch, wheel, or momentum input owns the scroller, geometry
corrections are deferred. When input settles, the pending correction is applied.
This keeps layout work from competing with an active gesture.

## Earlier history

When the logical viewport approaches the beginning of the loaded rows,
`shouldPrefetchEarlierChatHistory` requests another window through
`requestEarlierChatHistory`. `nextEarlierChatHistoryWindow` advances the request
window. The existing visible anchor is retained while older rows are inserted.

An exhausted history source and a failed request must remain distinguishable.
Callers should preserve and surface the request result instead of interpreting
an unchanged list as proof that no earlier messages exist.

## Floating controls

Rows are positioned with transforms inside an absolutely positioned slice.
Browser `position: sticky` therefore cannot reliably pin a control to the panel
viewport. Controls that must remain visible while their row scrolls, such as a
thread's collapse control, use `useFloatingCollapse` and painted coordinates.
They are absolutely positioned so moving the control does not change row height.

## Shared class name

`.fleet-chat-log` can occur more than once on a page. Code outside a panel must
not select the first element with that class and assume it found the intended
chat. A cross-component feature should receive the specific scroll element or
panel identity it operates on.

Likewise, code that changes a panel's scroll position must go through the panel's
scroll model. Direct `scrollTop` writes from unrelated subsystems bypass tail
mode, input deferral, anchoring, and history-prefetch behavior.

## Verification

Changes to this path need browser verification in the real application with a
chat long enough to virtualize. Exercise all of these cases:

1. New events arrive while the reader is at the tail.
2. New events arrive while the reader is reading earlier messages.
3. Earlier history is prepended near the top.
4. A mounted row grows or collapses without a new event arriving.
5. Wheel, touch, and momentum scrolling settle without a correction fighting the
   gesture.
6. Multiple chat panels are present, so element selection cannot succeed by
   accident.

Check the visible anchor before and after each operation. A green build or a
stable event count does not prove that the same content stayed on screen.
