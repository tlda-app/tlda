# tlda 0.4.0

This release turns tlda into a shared working environment for people and agent
fleets, broadens the document formats it can render, and substantially improves
touch and voice interaction.

## Highlights

- Fleet communication now uses per-agent subscriptions, supports one event
  addressed to multiple recipients, preserves recipient identity in history,
  and renders searchable threads directly from stored events.
- Terminal sessions participate in chat, including terminal-origin markers and
  safe terminal notifications. Agent lifecycle reporting, wake delivery,
  delegation, and native MCP login have also been tightened.
- Voice dictation now shares one submission path across composers. Draft text
  survives composer remounts, while completed sends clear their transcript
  state.
- Quarto Markdown projects render on the server, including RevealJS talks laid
  out as interactive slides on the canvas. Slide updates can replace a deck in
  place without reloading the browser.
- Touch interaction now covers the main canvas, document pages, slide frames,
  thread expansion, highlighting, voice controls, and spatial navigation.
- Source synchronization uses revision-checked transactions across browser and
  linked-checkout edits, with explicit conflict and build-failure delivery.

The release also includes many fixes to document layout, annotation anchoring,
search filters, agent naming and labels, reconnect behavior, and mobile-sized
controls.
