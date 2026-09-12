# Naming errata

This file records current identifiers whose names can mislead a contributor.
Treat each entry as a reading aid, not as authority to rename a live interface.
Remove an entry when the corresponding identifier is corrected.

## `markAgentNotAlive`

This function records negative liveness evidence, writes a hibernating runtime
state unless an explicit status says otherwise, and clears transient presence
and edit-activity markers. It does not set the durable `dead` flag and does not
delete source edits.

Read it as “record negative liveness evidence.” Unknown evidence is stored as
unknown and does not produce the durable transition.

## `activity-health`

This message is a heartbeat, not an activity record. It is delivered with a
latest-wins policy because each newer value supersedes the previous liveness
claim. `activity-event` is separate durable evidence and must not be dropped.

## `machine_id` on resolved daemon routes

Several resolved RPC route objects use `machine_id` for the complete daemon key,
including its environment component. Callers pass the value directly to daemon
delivery functions. Read this field as `daemon_key` at those call sites.

## `sha256` in source manifests

This field contains a Git blob object ID, currently SHA-1, obtained from Git tree
data. It is not a SHA-256 digest. Server manifests, daemon comparisons, and
revision payloads all depend on the Git object identifier having the same value.

## Fleet-store `waitMaxMs` and `waitMeanMs`

These queue statistics measure enqueue-to-settle latency. They include both time
waiting behind earlier work and the method's own execution time. They do not
isolate queue wait.

`maxDepth` is a lifetime high-water mark sampled when calls enqueue. It does not
fall after a backlog clears and does not sample periods in which nothing new is
enqueued.

## The two `parseDurationMs` functions

The frontend project-search parser and the shared notification-policy parser do
not accept the same grammar:

- the frontend accepts integer values with `ms`, `s`, `m`, `h`, `d`, or `w` and
  treats a missing unit as milliseconds;
- the notification parser requires a unit, accepts decimal values and long unit
  names, and supports through hours.

Do not assume a duration accepted by one surface is valid on the other, and do
not add a third parser for the same notation.

## Bot environment log files

`~/.config/tlda/<bot>.<env>.log` contains output from the launcher commands used
by the bot supervisor. It is not the bot runtime's own log. Inspect the bot's
tmux pane and heartbeat when determining runtime liveness.

## `resource-cleanup.mjs`

This module caps selected worktree `node_modules` storage against a configured
budget. It does not measure filesystem free space and is not a general disk
pressure reclaimer.

## `createPlaywrightPoolCleanup`

This cleanup reaps idle browser processes. It does not remove the corresponding
browser profile directories.

## `part`

A project “part” is a Markdown document copied into project-managed storage so
the application can open it as a canvas column. It is not a fragment of another
document. `.tlda/parts.json` is the durable record of these documents, not a
rebuildable cache.

## `checkpointProjectPartWritebackOffloop`

This function writes supplied content into a project-part file and updates the
baseline used for conflict detection. It does not read an upstream source file
or keep two files synchronized.

## `project-git-remote`

This daemon operation handles remote commands and two machine-local Git queries:
`read-file` and `repo-path`. The name understates its role as the existing route
for Git questions that only the checkout-owning daemon can answer.
