# Chat Context Tagging Spec

## Problem

When Skip sends a message from the chat shape, agents receive bare text with no context about what Skip is looking at. Agents say things like "I put it on your canvas" without knowing which document or page Skip has open. Skip has to manually explain his context in every message.

The chat shape sits on the TLDraw canvas — it has access to rich context that it's currently ignoring.

## What chat messages should include

When a message is sent from the chat shape, automatically tag it with metadata from the editor context:

| Field | Source | Example |
|-------|--------|---------|
| `doc` | Current document (URL / room name) | `"fleet-dashboard"` |
| `page` | Camera position → which page is visible | `3` |
| `camera` | Camera coordinates + zoom | `{x: 1200, y: 3400, z: 1.2}` |
| `visible_agents` | Which chat threads are expanded | `["opus-fixer", "guidance"]` |
| `nearby_notes` | Math notes near camera, with collapsed/expanded state | `[{id: "note-1", collapsed: false, text: "..."}, ...]` |
| `visible_shapes` | Notable shapes in viewport | `["playback-xyz", "annotation-123"]` |

## Note state awareness

Math notes are a major communication format — they render as chips in chat, sticky notes on canvas, collapsed dots. The state matters, but collapsed/expanded alone is ambiguous — a collapsed dot could mean "seen and dismissed" or "never seen."

### Read/unread tracking

Notes need explicit read/unread state, not just collapsed/expanded:

- **Unread** = agent placed it, Skip hasn't interacted with it yet. Shows a **red notification indicator** (dot/badge) on the collapsed note.
- **Read + collapsed** = Skip saw it and collapsed it (dismissed). No indicator.
- **Read + expanded** = Skip is actively looking at it.

The "unread" state is set when a note is created by an agent and cleared when Skip first expands it or interacts with it. The red indicator makes unread notes visually distinct from dismissed ones.

### Context metadata

Include note state in the chat context metadata so agents know what Skip is engaging with:
- Which notes are collapsed vs expanded
- Which notes are unread vs read
- Recently expanded = just opened, probably in response to something

## How agents use this

When an agent receives a message from Skip, the metadata is available alongside the text. The agent knows:
- Which document Skip is viewing (don't reference features from other docs)
- What page he's on (relevant for "look at this" or location-dependent feedback)
- Which agents he's actively chatting with (coordination context)
- What notes he's reading vs dismissed

## Implementation notes

- The chat shape already lives in the TLDraw editor context — it just needs to read `editor.getCamera()`, the room/doc name, and query nearby shapes
- Tag metadata on the message object before sending via fleet `chat()`
- Agents receive it as part of the message — no new tools needed
- The fleet chat display could optionally show context badges ("viewing: fleet-dashboard p3")
