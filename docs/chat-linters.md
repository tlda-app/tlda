# Pre-send chat linters

One explicit contract, per Skip's ruling (2026-09-28, messages 8679680–8679683):
a message the sender marks as an outline must be file-backed, because outlines
get edited. The sender marks the message; the server refuses a marked outline
that carries no source file. Nothing is inferred from length or shape —
ordinary messages, long or list-shaped, are never gated, and there is no depth
requirement. An earlier revision gated long inline messages and inferred
outlines from Markdown shape; Skip rejected that policy (messages 8679657–8679666),
and this document describes only what replaced it.

## The boundary (why the gate lives where it does)

Three processes touch chat, and only one sees every send:

- **MCP server** (agent-side, per-agent): owns the `chat()` tool. It validates
  recipients, parses `.suggest` sections, carries the explicit `outline`
  marking into the send body, and runs render checks — as warnings, never
  gates.
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
uploaded to the server and no source list is maintained there. A server refusal
propagates to the sender as
`⚠ chat NOT DELIVERED — the server refused it: <reason>. Re-sending will not
help; fix the cause.`

## Pieces

- `shared/chat-linters.mjs` — pure linter plus config normalization. No I/O,
  so both the server and the tests import it directly.
- `shared/chat-linters.test.mjs` — unit tests: config normalization, the
  marked/filed pass/fail boundaries, strict `true` marking, unmarked
  pass-through.
- `mcp-server/fleet-tools.mjs` — the `chat` tool's `outline` boolean arg,
  carried into the send body only when true. Absent means an ordinary message.
- `server/unified-server.mjs`, `type === 'chat'` — the gate. Runs after the
  idempotency replay check and recipient/sender resolution, before anything is
  stored. Refused sends record no `_tempId`, so fix-and-resend is clean, and
  already-accepted sends stay accepted across config changes. Refusals append a
  `chat.lint-refused` control-plane trace carrying `{ from, to, linter }`, never
  the body.
- `test/chat-linters-ingress-wire.test.mjs` — boots a real server with a temp
  config dir and DB, then speaks the same WS `chat` frames the MCP sends:
  marked-inline refusal, marked-filed/long/list/human acceptances, the
  unconfigured path, and proof the refused send stored nothing.
- `test/chat-linters-surface-wire.test.mjs` — drives the real MCP `chat` tool
  handler over the real transport against a booted temp server, proving the
  marker travels the whole path: marked-inline refusal, marked-filed/long/list
  acceptances.
- `server.yaml` `chatLinters:` key (see `shared/daemon-config-schema.mjs`).
  Absent means the linter is off. Read per send — chat volume makes a YAML
  read trivial, and the config is always fresh.

## Config

```yaml
chatLinters:
  outlineFileBacked:
    enabled: true
```

## Contract

`lintChatOutbound({ source, outline, config })` returns `{ pass: true }` or
`{ pass: false, linter, error }`. The `error` names the linter, the defect, and
the fix — it becomes the refusal reason the sender sees — and carries no
trailing period, because the refusal template appends one. Only an explicit
`outline === true` marks a message; truthy non-booleans do not gate.

## Deliberate non-goals

- No length rule and no shape inference. A previous revision had both; Skip
  ruled them out.
- No depth requirement on outlines. File-backed is the whole contract.
- The `amend` path is ungated. It is the fix path for already-delivered
  messages.
- Humans (Skip, `senderAgent.human` or the server owner id) are never gated.
- A `server.yaml` that cannot be read fails open (loudly, in the server log).
  Chat is the accessibility-critical channel; refusing a send for a reason the
  sender cannot fix is worse than an unlinted message.
- No recipient- or label-based exemptions, and no changes to chat defaults,
  routing, identity, or visibility beyond the one `outline` input.
