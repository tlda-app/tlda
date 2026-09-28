# Pre-send chat linters

Configurable binary gates on outbound chat. A failing linter blocks delivery
and returns a useful error to the sender; passing (or unconfigured) chat is
unchanged. Built for Skip's 2026-09-28 request: agents vomiting unstructured
text at him, handing flat lists over as outlines, and paraphrasing him under
his own authority. The linters enforce the two mechanically checkable halves —
file-backed composition and outline depth.

## The boundary (why the gate lives where it does)

Three processes touch chat, and only one sees every send:

- **MCP server** (agent-side, per-agent): owns the `chat()` tool. It validates
  recipients, parses `.suggest` sections, and runs render checks — as warnings,
  never gates ("we don't bounce a message, ever" is still true *there*).
- **Daemon** (machine-side, per-machine): owns agent lifecycle, mint, wake, and
  daemon→server ops. It never sees chat bodies — chat travels MCP → server
  direct over WS. Putting a gate in the daemon would mean rerouting all chat
  through it: a new proxy with new failure modes, larger than the feature.
- **Server** (central): owns chat ingress (`type === 'chat'`), recipient
  resolution, persistence, delivery, and wake. Every send — MCP, native
  bindings, one-shot WS — terminates here, so ingress is the single choke point
  where a gate is real against bypass.

So: **enforcement at server ingress, executables in `shared/`, config held by
the server.** The linter code ships with the normal deploy — nothing is
uploaded to the server and no source list is maintained there — which dissolves
the cost behind the daemon-level leaning while keeping the gate central. The
MCP needed no change: a server refusal already propagates as
`⚠ chat NOT DELIVERED — the server refused it: <reason>. Re-sending will not
help; fix the cause.`

## Pieces

- `shared/chat-linters.mjs` — pure linters plus config normalization. No I/O,
  so both the server and the tests import it directly.
- `shared/chat-linters.test.mjs` — unit tests: config normalization, both
  linters' pass/fail boundaries, conservatism cases (prose, bare lists, fenced
  and quoted signals), linter ordering.
- `server/unified-server.mjs`, `type === 'chat'` — the gate. Runs after the
  idempotency replay check and recipient/sender resolution, before anything is
  stored. Refused sends record no `_tempId`, so fix-and-resend is clean, and
  already-accepted sends stay accepted across config changes. Refusals append a
  `chat.lint-refused` control-plane trace carrying `{ from, to, linter }`, never
  the body.
- `test/chat-linters-ingress-wire.test.mjs` — boots a real server with a temp
  config dir and DB, then speaks the same WS `chat` frames the MCP sends:
  both refusals, acceptance to a dead (non-delivering) recipient, the human
  exemption, the unconfigured path, and proof the refused sends stored nothing.
- `server.yaml` `chatLinters:` key (see `shared/daemon-config-schema.mjs`).
  Absent means every linter is off. Read per send — chat volume makes a YAML
  read trivial, and the config is always fresh.

## Config

```yaml
chatLinters:
  fileBackedComposition:
    enabled: true
    minChars: 500        # at or over this length, inline chat fails
  outlineDepth:
    enabled: true
    minSignalLines: 5    # unheaded bold-label beats needed to qualify
    maxProseLines: 2     # more surrounding prose than this passes
```

## Contract

`lintChatOutbound({ text, source, config })` returns `{ pass: true }` or
`{ pass: false, linter, error }`. The `error` names the linter, the defect, and
the fix — it becomes the refusal reason the sender sees. File-backed
composition runs first, so a long inline outline is told to move into a file
before it is told to nest.

- **file-backed-composition**: at or over `minChars` with no `source.file`
  fails. Short chat and `file`+`selector` sends pass.
- **outline-depth**: a purported outline with a single structural depth fails.
  A bare list is honestly a list and passes — the linter fires only on
  presentation-as-structure (an outline/beats/structure heading over a flat
  body, or an unheaded run of bold-label beats), with no second depth
  (no second heading level, no nested or sub-numbered items, no beats carrying
  bullets) and at most `maxProseLines` of surrounding prose. Ambiguous shapes
  pass: a false block on legitimate chat is worse than a missed list.

## Deliberate non-goals

- The `amend` path is ungated. It is the fix path for already-delivered
  messages; gating it could trap a sender, and delivered messages passed at
  send time.
- Humans (Skip, `senderAgent.human` or the server owner id) are never gated.
  The failure mode is agents vomiting at him, not the reverse.
- A `server.yaml` that cannot be read fails open (loudly, in the server log).
  Chat is the accessibility-critical channel; refusing a send for a reason the
  sender cannot fix is worse than an unlinted message.
- No recipient- or label-based exemptions, no new chat arguments, no changes to
  chat defaults, routing, identity, or visibility.
