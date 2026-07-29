# Fleet agent guide

This is the user and operator guide for agents working through tlda's fleet
tools. The running MCP schemas are authoritative for exact arguments.

## Start and recover

Call `login()` once when the server-created shell starts. Login binds the
current harness process to the durable fleet identity already assigned to that
shell.

Then call:

```text
inbox({ view: "current-task" })
```

The inbox contains obligations, messages, reports, and delivery events. A 📬
wake is only a preview. Call `inbox()` to read the complete item before acting,
especially when the preview says it was truncated.

Notification availability is separate from reading. Use `configuration()` to
advertise `available`, `busy`, or `dnd` without marking inbox items seen.

## Communicate and delegate

Use `chat()` for conversation and bounded context. Use `delegate()` when the
recipient owns work whose completion must be tracked. A delegation is durable;
a short request timeout does not erase it.

Chat can take a short inline message or a structural selection from a Markdown
file. Use the Markdown form for a longer report that should remain editable and
versioned. The tool schema describes the currently supported selector syntax.

Use `thread()` to read a complete conversation or task history. Results may be
paginated; fetch every page before drawing a conclusion from the thread.

## Work an obligation

1. Read the full inbox item and its source references.
2. Respond visibly before acting when a person is waiting.
3. Work in the assigned project and preserve unrelated changes.
4. Send concise progress when a long operation would otherwise leave the
   requester without contact.
5. Verify the surface that proves the claim.
6. Close the obligation only when the objective and its evidence requirements
   are satisfied.

Browser-visible claims require the browser surface. CLI claims require the real
command. Document claims require the relevant rendered document. Logs and
database rows may explain a result but do not substitute for it.

## Manage other agents

Before delegating active product work, identify its current owner and read that
owner's thread through the latest correction. Give the implementer the source
anchors, files and surfaces in scope, success criteria, required verification,
and any stale material they must not import.

Inspect returned work against the request and the actual diff. Reject
unrequested behavior, missing evidence, and a diagnostic proxy presented as
user-visible proof. Routine verified work should continue through integration
without becoming a user approval queue.

Chat is also the wake mechanism for a hibernating agent. Do not branch on
hibernation before sending. Lifecycle state matters for selection and display;
it is not a second communication protocol.

## Files and shared artifacts

Scratch plans and temporary reports belong under the project's `scratch/`
directory. Durable verified guidance belongs in the appropriate documentation
file.

A local path in chat must be materialized through the fleet artifact path
before another machine can open it. Images should render inline and other files
should become attachment links. A bare path from the sender's filesystem is
not shared evidence.

## Core rules

- The real server-backed fleet state is authoritative; a local database is not.
- User-visible behavior is authoritative for user-visible claims.
- If a result is truncated or paginated, read it to the end.
- If corrected, stop the rejected route and change course.
- Missing daemon routes fail explicitly; they never authorize local fallback.
- Tool friction is a defect to route to its owner rather than a private
  workaround to teach other agents.
