# Offline-Capable Agent Identity

Status: approved implementation contract. This records the system agreed with
Skip before reading the current implementation. Code must be changed to match
this contract; existing code is not evidence for changing the contract.

## Goal

An agent created by a local daemon must be usable without a server connection.
When a server becomes available, that same local agent may acquire exactly one
server identity without rewriting its local identity or recreating its process
or conversation.

## Identities

There are two independent identifiers:

- `local_agent_id`: minted by the daemon when it first creates the local agent.
  It is stable for the lifetime of the daemon's record and is the join key for
  all daemon-owned data.
- `server_agent_id`: minted only by the server. It is absent for an unbound
  local agent and, once attached, identifies that agent on the server.

Neither identifier is derived from the other. A request ID, session ID, tmux
name, friendly name, or process ID is not an agent identity.

## Daemon ledger

### Agents

One row per locally known agent:

- `local_agent_id` — primary key
- `server_agent_id` — nullable, unique when present
- `friendly_name` — nullable server-synced cache

The `(local_agent_id, server_agent_id)` association is a one-time binding:

- an empty `server_agent_id` may be filled once;
- writing the same value again is an idempotent success;
- changing a nonempty value or binding one server ID to two local IDs is an
  error;
- disconnect, hibernate, wake, and login never clear or change it.

### Conversation

One row per local agent, keyed by `local_agent_id`:

- `local_agent_id`
- `session_id` (also the harness resume handle)
- `harness`
- `model`

### Process recipe

One row per local agent, keyed by `local_agent_id`:

- `local_agent_id`
- `tmux_name`
- `cwd`
- `permission_profile`

The recipe describes how to create the next local process. PID and liveness are
observed from tmux and are not durable ledger fields.

### Spawn authority across boxes

Permission profiles are daemon-local: they name concrete paths and operations
on one box. The server never interprets them or grants permission.

Each daemon may explicitly grant known agent IDs a local profile. Agents minted
later cannot all be enumerated in configuration, so their grants are inherited
and written lazily to that daemon's ledger when they first spawn a child there.

For a cross-box spawn, the server faithfully forwards the requester's
`server_agent_id`, source daemon ID, and source daemon's permission class. The
destination daemon owns a mapping from `(source daemon, source permission
class, optional agent ID)` to a destination-local profile. It resolves and
persists the requester's destination-local grant before authorizing the child.
The server stores no filesystem policy and performs no permission comparison.

A child grant is the intersection of the requested child profile, the model
ceiling, and the requester's destination-local grant, so it cannot exceed the
requester. The resulting child grant is persisted under the child's stable
agent ID, so wake preserves it and later spawns cannot escalate it.

Therefore the logical permission relation is sparse `(agent, box)` state:
explicit configuration supplies roots; successful delegation supplies durable
descendant rows. An agent with neither an explicit nor inherited grant on a box
cannot spawn there.

### Mint requests

Mint requests are transient operations, not identities and not join keys for
canonical agent data. A request may contain:

- `request_id`
- requested name and launch options
- state: `pending`, `succeeded`, or `failed`
- result `local_agent_id` and/or `server_agent_id`, when known
- error details

Requests provide correlation and idempotency. Successful canonical records are
always keyed by `local_agent_id`; they never remain joined through `request_id`.

## Protocols

### Local-first mint

1. The daemon mints a `local_agent_id`.
2. In one local transaction it writes the agent, conversation, and process
   recipe, then starts the harness process.
3. The agent is immediately usable locally. No server, server ID, or friendly
   name is required.
4. When connected, the daemon sends the server a mint request associated with
   this local agent. The local ID is an opaque daemon-side correlation value,
   not a proposed server identity.
5. The server creates or idempotently returns its own `server_agent_id`.
6. The daemon atomically performs the one-time binding. It then caches the
   server-authoritative friendly name, if supplied.

If the response is lost, retrying the same mint request must return the same
server agent. It must not create an imposter or a second server identity.

### Server-first mint

1. The server creates a shell/agent and mints `server_agent_id`.
2. The server asks a daemon to launch it, carrying that server ID and launch
   options.
3. The daemon mints a new `local_agent_id` and transactionally creates the
   local records with the one-time binding already populated.
4. A retry of the same server request returns the existing local agent. It must
   not launch a duplicate process or bind a second local identity.

MCP mint is this server-first path because the MCP request passes through the
server.

### Login

Login attaches a running harness session to an existing local agent. It may
record or validate `session_id` and process information. It does not mint an
agent, create an identity binding, rewrite an agent key, or manufacture missing
server state.

### Hibernate and wake

Hibernate stops the current local process but preserves the agent,
conversation, process recipe, and any server binding.

Wake creates a new process for the same `local_agent_id`, resuming its stored
conversation and using its stored process recipe with explicit overrides. If
the preferred tmux name is occupied, the daemon selects a unique actual name
and stores it only after successful process creation. Wake never mints or
changes agent identity.

## Boundary resolution

Daemon internals and local commands use `local_agent_id`. Server APIs and
messages use `server_agent_id`. Code at the server/daemon boundary resolves the
immutable binding once; application code does not guess, coalesce, or treat the
two ID domains as interchangeable.

An unbound local agent cannot receive server-addressed work, but it remains
fully usable locally. A bound agent whose server is unreachable remains usable
locally and retains its binding for reconnection.

## Failure rules

- Local persistence must succeed before a locally minted process is reported as
  created.
- Server creation and daemon binding are retryable through the mint request's
  idempotency key.
- A conflicting binding is a hard error requiring investigation; code must not
  overwrite, merge, or silently choose an identity.
- Partial launch failure must not leave a record advertised as a live process.
- Reconciliation may finish an incomplete request or restore a missing process,
  but it may not invent or change identity bindings.

## Migration requirement

Existing rows must be classified before writer cutover. Each valid daemon agent
receives one stable `local_agent_id`; an existing genuine server association is
copied into the nullable binding only when unambiguous. Ambiguous or conflicting
rows are quarantined for explicit repair. The new writers must not run until the
schema, backfill, uniqueness constraints, and read-path verification have all
completed.

## Acceptance cases

The implementation is acceptable only if automated and real-surface tests show:

1. local mint, use, hibernate, and wake while the server is unavailable;
2. later binding of that same local agent to exactly one server identity;
3. lost-response retry without duplicate server or local agents;
4. server-first/MCP mint without duplicate local processes on retry;
5. login without identity creation or mutation;
6. rejection of every conflicting rebinding attempt;
7. a bound agent surviving disconnect and reconnect with both identities intact;
8. migration rejecting ambiguous legacy identity rather than guessing.
9. Doctor YOLO can mint and use a local CLI agent while disconnected, then
   bind that same agent once to the server without losing its conversation,
   process recipe, permissions, or ability to wake.
10. a remote agent can spawn on another box only through that destination's
    configured source-class mapping; the derived grant is persisted locally;
    child grants cannot exceed it; and the server merely forwards the
    authenticated identity/daemon/class tuple.

Doctor YOLO must call the same local-mint primitive as ordinary local creation.
Its only specialization is the break-glass permission profile and immediate
terminal attachment. It must not reserve a shell first, mint its own identity,
or maintain a second launch/binding protocol. A structural regression test must
enforce this shared-path rule.

## Deferred live verification

Cross-daemon mapping is implemented and unit-tested, but Air↔Mini policy wiring
and live cross-daemon spawning are intentionally deferred until that workflow is
needed. Before enabling it, configure both destination daemons' `remoteGrants`
maps and verify a real spawn in each direction. This does not block the local
mint, permission inheritance, wake, login, or Doctor YOLO acceptance cases.
