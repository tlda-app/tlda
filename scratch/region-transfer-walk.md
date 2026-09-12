# The region transfer card walk

For whoever holds the camera. **Read `scratch/region-transfer-card-intention.md` first** — it
is what the frames are supposed to fail against, and it was written before the code.

## What the frames must show

**Frame 1 — the transfer happened.** A real `region_transfer` call on two disposable files
of your own, returning its unified diff. Not a fixture, not a replayed event.

**Frame 2 — the card, in a chat.** The activity card for that call, in the app, showing:

- the call, `tlda/region_transfer`, with the target file;
- **the diff, side by side** — the bytes that left the target on the left, the bytes copied
  in from the staging file on the right;
- nothing restating it underneath.

Skip, 2026-09-12: **"it was meant to look like edit."** So the card should be the ordinary
edit-diff card — file basename with `+n −n`, then the two sides. **If it draws as a plain
`tlda/region_transfer` line with no diff, that is the defect this branch exists to fix and
the frame where you found it is the result.**

## Step 0, and it is the whole obstacle

**The fix is server-side** — `server/lib/daemon-activity-ingest.mjs` decides whether the
tool result crosses to the browser at all. So **a client-side preview against somebody
else's store cannot show this**: the vite-proxy trick works for client changes and cannot
work here, because the store that answers is the one running the old server code.

**The server that receives the activity must be running `de9d74908`.** Two routes.

### Route A — after the deploy (simple, preferred)

Once a deploy carrying `de9d74908` is serving, there is nothing to stand up:

1. In a fresh scratch directory, write two disposable files — a `.md` staging file and any
   target file. The source **must** end in `.md` or `.markdown`; the tool refuses otherwise.
2. Call `region_transfer` with `source_file`, `source_start_line`, `source_end_line`,
   `target_file`, `target_start_line`, `target_end_line`, and `expected` — `expected` being
   the exact text inside the target range that is to be replaced. It fails loudly if that
   text is not found, is not unique in the range, or if either range is outside the file.
   Keep both regions to two lines; a long diff tells you nothing extra.
3. Open the app as yourself and look at your own chat panel on yourself. An activity event
   is `from` you, and the DM clause admits the target agent's own activity, so a panel on
   the agent that made the call is where the card is.
4. Capture it: `screenshot(project: <a project you can open>, shapeTypes: ["fleet-chat"])`,
   which renders the chat shape alone with no document pages.

### Route B — before the deploy, from this worktree (UNVERIFIED, say so if you use it)

**I have not run this end to end, and I am not going to hand you a recipe I have not run
as though it were one.** What I know:

- `tlda-dev serve --sandbox` in `/Users/skip/worktrees/region-transfer-card` stands up this
  branch's server **and** a fleet daemon wired only to that sandbox. I started one; its URL
  and status are in the message that came with this file.
- **The call has to be made by an agent whose daemon is the sandbox daemon.** Activity
  reaches a server through the daemon for that environment, so a `region_transfer` run by
  an agent on the ordinary `testing` daemon lands on the ordinary server and proves nothing
  about this branch.
- **Do not create a project from the sandbox.** The chief's standing warning: the `project`
  verbs do not honour the sandbox's isolation and can reach the live box.

If Route B turns into an afternoon, it is not worth it — say so and wait for Route A.

## What counts as a failure worth sending

Any of: the card draws without a diff; the diff shows the wrong side; the card does not
appear in the panel at all; the call itself errors. **Send the frame where it stopped.**
Do not come back to me to have it explained, and do not repair it to complete the story.

## What is out of scope

The **nope** affordance — still OPEN in the record, deliberately unbuilt. `search`, `thread`
and `screenshot` cards are untouched by this branch and are not part of this walk.
