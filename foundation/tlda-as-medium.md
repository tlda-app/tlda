# tlda as a collaboration medium

tlda is a canvas-based document review system in which people and agents share
documents, annotations, conversations, project history, and source-editing
surfaces.

```text
human collaborators                 agents
        |                              |
        v                              v
  browser canvas <---- tlda ----> MCP and daemon tools
        |                              |
        +---- shared project state ----+
```

## Documents

tlda renders versioned LaTeX, Markdown, Quarto, HTML, and PDF documents. The
viewer places pages on a tldraw canvas and keeps source-aware annotations
anchored across rebuilds where the source format permits.

Highlights, notes, arrows, drawings, and other canvas objects are synchronized
as tldraw shapes. Document history and source locations let collaborators refer
to the same passage even as the rendered artifact changes.

## Fleet collaboration

Fleet chat lives beside the document rather than in a separate application.
Messages support Markdown, math, code, task and lifecycle cards, tool results,
and document-region attachments.

Each agent has a durable identity, thread, task inbox, and machine route. Human
and agent participants see the same stored conversation through interfaces
suited to their interaction mode.

## Main components

| component | responsibility |
| --- | --- |
| browser client | Canvas, document viewer, chat, source editor, settings, and media controls. |
| server | SPA and asset serving, APIs, fleet state, WebSockets, Yjs rooms, builds, and project history. |
| daemon | Machine-local source watching, build coordination, agent lifecycle, and terminal operations. |
| MCP server | Agent-facing fleet and document tools. |
| project store | Versioned sources, rendered outputs, uploads, and synchronized document state. |

The server runs the SPA, APIs, fleet WebSocket, and synchronization surfaces in
one Node process. The daemon connects local files and processes to that server;
it is not a second application server.

## How changes move

- A browser edit updates shared Yjs state, persists through the server, and is
  broadcast to other clients.
- An agent message enters through MCP, is stored by the fleet server, and is
  rendered in subscribed chat views.
- A source change reaches the daemon, triggers the configured build path, and
  produces a reload signal after new output is ready.
- Agent activity is normalized into fleet events that can be rendered beside
  the conversation.

## Design properties

- Canvas elements use tldraw shapes, properties, selection, and synchronization.
- Important interaction paths work with pointer and touch input; keyboard
  shortcuts are optional accelerators.
- Current interfaces replace deprecated ones rather than accumulating
  compatibility shims without a present requirement.
- Document, chat, and activity events retain enough project/version context to
  be interpreted later.
- User-visible claims are verified in the real browser application; internal
  state and tests are supporting diagnostics.

## LaTeX build path

For a LaTeX project, the standard pipeline is:

1. `latexmk` builds DVI output;
2. `dvisvgm` creates per-page SVGs;
3. SyncTeX data provides source anchors;
4. cross-reference analysis produces navigation metadata.

Rendered output is stored per project. Other document formats use their native
or format-specific build paths; see [Document formats](../docs/document-formats.md).

## Shared result

The persistent canvas, synchronized document state, version-aware conversation,
and source references form one working medium. A participant can point to a
document region, discuss it, edit its source, and recover the resulting history
without translating between separate collaboration systems.

See also [Current architecture](../docs/current-main-architecture.md) and
[The fleet agent experience](agent-experience.md).
