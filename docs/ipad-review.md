# iPad Review Mode

Reference for using the MCP annotation tools in an iPad review session. This file is meant to be included in `~/.claude/CLAUDE.md` or a project-level `CLAUDE.md` so Claude Code knows how to behave during a review.

---

## Setup

1. Start the server: `tlda server start`
2. Start watchers: `tlda watch-all start`
3. Open in browser: `tlda open <name>`
4. For iPad access, generate a QR code pointing to the server:
   ```bash
   # Get your LAN or Tailscale IP
   ifconfig | grep 'inet '
   # Generate QR code for iPad to scan
   node -e "import('qrcode-terminal').then(m => m.default.generate('http://YOUR_IP:5176/?doc=DOC_NAME', {small: true}))"
   ```

## The Loop

When the user is reviewing on the iPad, switch to a **reflective, conversational** mode. The iPad is good for pointing and highlighting; it's bad for writing detailed instructions.

1. `wait_for_feedback` blocks until user draws/taps/pings
2. `read_pen_annotations` to get structured interpretation of marks (fast, cheap)
3. `screenshot` if marks are ambiguous (handwriting, symbols the shape interpreter can't parse)
4. Interpret the annotation. Send a `send_note` with `choices` parameter for multiple-choice buttons the user can tap. Standard options for edits:
    - "This" (proposed fix is correct)
    - "Something like this" (right direction, needs adjustment)
    - "Way off" (misread the annotation)
    - "Leave it for now"
5. `wait_for_feedback` returns `Choice selected on shape:...` with `selected` index and label
6. If "This" or "Leave it" — `mark_done(doc, id)` to acknowledge, move on
7. If "Something like this" or "Way off" — wait for further guidance, iterate
8. Collect confirmed edits; don't touch the source until the review session ends or user asks

For questions (user writes a question or highlights with a "?"):
1. Answer via `send_note` with math support (`$...$` and `$$...$$`)
2. Offer satisfaction choices: "Got it, thanks" / "Still confused" / "I meant something else" / "Leave it for now"

## Key Rules

- **Default to reflecting and proposing, not doing.** Each ping is a conversation turn, not a work order.
- **Start listening for pings proactively** when the iPad is in play. Don't wait to be told.
- **Questions get answers, not actions.** If the user asks about something, answer it. Don't auto-rebuild, auto-deploy, or auto-edit.
- **Use `choices` for all responses.** Text checkboxes are not interactive — always use the `choices` parameter to get real tappable buttons.
- **Mark done to acknowledge.** After resolving an annotation, use `mark_done(doc, id)` to check it off. This collapses and dims the note and moves it to the page margin. Pass `margin=false` to keep it in place. Don't create separate acknowledgment notes.
- **All communication goes through notes, not chat.** The user is on the couch with no keyboard. Everything must be tappable.

## Scene Understanding

The MCP tools don't return raw canvas coordinates — they return structured descriptions of what's on the page. This is what makes the review loop work without screenshots for most interactions.

**`describePagePosition()`** converts canvas coordinates to human-readable locations like "page 3, upper-left" or "page 7, right margin". Every shape returned by `read_pen_annotations` and `wait_for_feedback` includes this.

**`classifyGesture()`** interprets freehand pen strokes by aspect ratio: dot, strikethrough, underline, vertical line, bracket, or circle. Combined with position and nearby source lines, this tells the agent what the user meant without needing a screenshot.

**`collectDrawnShapes()`** is the unified shape collector used by both `read_pen_annotations` and `wait_for_feedback`. For each shape it returns:
- Type (pen, highlighter, arrow, geo, text, note)
- Color, gesture classification, page position
- Nearby source lines (from synctex lookup)
- Rendered text under the mark (from SVG text extraction)
- Creation timestamp (for recency)
- Magic highlighter metadata (extracted text, glow rects) when available

**`buildPageSummary()`** generates a per-page count header at the top of `read_pen_annotations` output — e.g. "Page 5: 3 marks (2 pen, 1 highlighter)" — so the agent can quickly see where activity is concentrated.

**`buildNearbyContext()`** is appended to `wait_for_feedback` results. It shows other shapes on the same or adjacent pages, clustered by time and space, so the agent understands the broader context of a new annotation — not just the mark itself, but what else the user has been looking at recently.

## Diagnostics

- **`read_pen_annotations` first** (fast, cheap), then **screenshot when marks are ambiguous**.
- **Ping with unclear marks → screenshot immediately.** Don't guess from rendered text.
- **Use `screenshot(doc, page=N)` with an explicit page number** to see where the user is annotating.

## Interaction Tempo

- **Clear textual instructions → act fast.** Don't over-read before making the change.
- **Don't flood with `wait_for_feedback` calls.** If nothing new comes back, the user may be thinking or drawing.
- **Describe locations by content** ("look at the entropy discussion"), not line numbers.
