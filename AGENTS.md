# tlda contributor guidance

## Before you ask for a thing, check whether it already exists and is broken

**Existing-and-broken and missing are different problems, and only one of them
needs Skip.** A half-working feature is invisible: nobody sees it work, so
everybody concludes it does not exist and asks for it to be built. The request
is then for the wrong thing, and Skip has to correct the record — again.

So, before reporting a gap, proposing a feature, or putting a row on a board:
**search for the capability and find out whether it is implemented.** If it is,
the work is repairing it, and say so in those words.

Two instances from one night, 2026-09-10:

- Six agents reported "there is no way to know whether my build finished" and a
  chief ranked *add a build-completion primitive* as the top request. **The build
  card already exists** (`server/unified-server.mjs:3251`) and carries `summary`,
  `errors`, `warnings`, `lintFindings`, `buildFiles`. It reaches agents as a bare
  `Build <hash> — <doc>` line because the content lives in `metadata` and only the
  browser renders it. The right ticket was *repair the card*, not *build a
  primitive*.
- A note recording "Quarto cannot render under the agent fence" was cited as
  documented fact. Agent sessions had rendered real chapters four times that
  night. Work had been routed around a capability that works.

**A remembered fact is not a measurement.** Re-check before citing one, and treat
a comment, note, or memory that asserts a mechanism as a lead rather than
evidence.

---

tlda is a collaborative document-reading and annotation system. It renders
versioned LaTeX, Markdown, Quarto, HTML, and PDF documents on a tldraw canvas,
keeps annotations anchored to source where the format permits, and gives people
and agents shared project, chat, search, history, and source-editing surfaces.

## Work on the requested behavior

- Make the smallest change that satisfies the current request.
- Preserve unrelated work in a dirty checkout.
- Do not introduce new defaults, routing, onboarding, layout, synchronization,
  visibility, or authority behavior as a side effect.
- Read the complete current path before editing it. A surprising function means
  more of the path remains to be understood.
- Comments and historical tests describe earlier implementations; they are not
  product authority.
- Prefer deleting an unnecessary path to adding validation, reconciliation,
  retries, caches, or compatibility around it.
- Do not preserve deprecated aliases or compatibility shims unless a current
  requirement needs them.
- Do not push, publish, deploy, rewrite history, or send external messages
  without explicit authorization.

A subsystem is a product decision. If a fix develops its own registry, journal,
control plane, materializer, projection, lifecycle, or authority model, stop and
surface that design before building it. A symptom authorizes fixing the symptom,
not constructing an adjacent architecture.

## Resolve unspecified behavior before implementing

List the points the request does not settle. Check the requester's existing
specification before asking again. If a point is genuinely unsettled and changes
the product decision, ask; do not silently choose a default.

After implementing, compare the result with the request itself, not only with
the plan used to implement it. Check what else the change affected.

Small additive requests from human collaborators are ordinarily safe when they
are reversible and do not alter defaults or shared behavior. Defaults,
onboarding, layout, routing, synchronization, visibility, and authority remain
product decisions.

## Preserve user work

Comments are metadata, not spare storage for deleted prose. Do not edit or remove
them unless the task explicitly includes comments.

Do not replace, revert, stage, or commit unrelated work in a shared checkout.
Inspect status before editing and again before any commit. Stage exact paths.

A feature removal includes its controls and configuration. A deleted
implementation with a settings control left behind creates an inert control.
Use [Settings controls](docs/settings-controls.md) to check preference keys,
conditional consumers, CSS-variable consumers, and runtime gating.

## Investigate regressions from history

When behavior that used to work disappears, treat it as a regression until the
record shows otherwise.

Use these checks in order:

1. `git log -S` on a symbol in the failing path;
2. check whether a repair exists on an unmerged branch;
3. when some cases work, locate the boundary between working and failing cases.

A current comment, note, line number, or commit subject can be stale. Before
using it as a causal explanation, find the commit that last changed the
mechanism and inspect the current call site. A commit touching a failure may be
the repair rather than the cause.

Git authorship does not establish who designed or approved a change. Establish
product direction from the actual request and its surrounding context.

## Verify the relevant surface

The user-visible surface is authoritative for user-visible behavior. Builds,
tests, logs, database rows, and source inspection are diagnostics.

- Verify a CLI change with the real command.
- Verify a document change in the relevant rendered document.
- Verify a UI change in the real application environment on a document that is
  not actively in use.
- Use `tlda-dev pw` only when browser interaction is the behavior under test.
- When supported automation cannot exercise the behavior, state the exact
  missing proof.

A check must be able to fail for the defect it claims to detect. Run a
counterfactual or positive control whenever a green result could also mean the
instrument did not measure the target.

For shell pipelines, preserve the exit status of the command being tested.
Silence is not proof of zero matches when the command itself may have failed.

Before claiming completion, re-run the relevant checks against the final diff
and inspect the surface that proves the requested behavior.

Never work inside a project someone is actively using. The reason is state: an
agent working in a live project can corrupt its tldraw store or the files on
disk. That is the only reason for the rule — it is not about which projects
exist, who owns them, or what they are called.

Test on a copy of an actively used project rather than on an empty one. This
matters most when the work came out of that project: a fix for a bug encountered
there, or a feature prompted by something that happened while working in it.
Classroom features are tested against the course's own content; a feature
touching churn, versions, or history is tested against real churn in the real
history of a real project.

A fixture is for development, not for acceptance. Developing against one is fine
and often the fast way to work, but it exercises a thinner path than a real user
is on, so passing against a fixture is not evidence that the feature works. This
is the ordinary distinction between a unit test and a behavior test.

## Failure messages

A failure message reports what the system already knows. At the moment something
fails, the process holds the relevant state; the message should carry that state
rather than direct the reader elsewhere. The reader who needs the message is by
definition the one who does not know where to look.

Put the evidence inline, and say what produced it and when it was observed, since
an observation can go stale between the failure and the reading. Where looking
again is genuinely useful, give the exact invocation rather than the name of a
tool.

An imperative in a failure message — check this, run that, see the log — is the
system declining to report something it already has. Naming a symptom of a cause
the system could have observed directly is the same defect. Reporting success for
an action that did not occur is its strongest form.

## Source and synchronization

A tlda project's synchronized source is the transitive dependency closure of
its declared document roots. Do not add manifest authority or a parallel source
registry to approximate that closure.

Project source is versioned and submitted through the revision-checked source
transaction. Browser edits and daemon-submitted checkout edits use the same
server boundary. Do not silently overwrite a linked checkout.

The server and machine daemon deploy independently. A field on their wire cannot
be removed atomically:

1. make the receiver tolerate absence;
2. stop the sender from sending it;
3. remove the receiver's remaining reader and validation.

These are temporary rollout stages, not permanent compatibility shims.

A transport acknowledgment proves that a dispatcher accepted an envelope. When
the caller must know that work happened, require a response emitted by the
handler after it verifies the effect.

## Fleet state and communication

Fleet state lives in fleet tools, not filesystem notes. If a result is paginated,
read every page required for the decision.

Read conversation threads in order. Search results are pointers to context, not
a substitute for the surrounding exchange.

Humans and agents share identity, inbox, labels, and subscription filters.
An inbox row proves a message is readable. A visible filter proves what a person
can see when they open the app. Only the notification delivery path proves an
agent was told to wake.

Addressing and subscription are different:

- an address expression records who a message is for;
- subscriptions determine which readers receive or foreground it.

Do not project a reader's current subscription into a message's historical
address.

A handoff transfers ownership. After acceptance, the successor is the sole
destination for drafts, status, review, and approval. A bounded factual history
question may still go to the predecessor.

Persistent community bots are continuity infrastructure. Do not rename, stop,
or replace a healthy bot to reduce noise. An observed runaway may be stopped as
an emergency circuit breaker, followed by restoration after the cause is fixed.

## Configuration and deployment

Repository examples must use placeholders or reserved example domains. Do not
commit personal paths, credentials, private hostnames, private project names, or
deployment-specific secrets.

Configuration files under `config/` are public examples. Put private values in
deployment-owned configuration or secret storage.

The guarded Fly deployment procedure is documented in
[Fly deployment](docs/live-deploy.md). A successful build or accepted push does
not by itself prove which revision the running application serves. Verify
`/api/build-info`, `/api/health`, and the relevant user-visible behavior.

A deployment updates the server image, not every long-running daemon. Restart
and verify affected daemons when a change spans both halves.

No unattended job may initiate a deploy. A job that waits on a condition and then
pushes is a deployer, whatever it is called — a parked background task, a retry
loop, a lock-waiter, a timer, a cron entry. Two properties make this unsafe
regardless of how little the job costs to run. It fires at the worst available
moment by construction, because it starts when the previous deploy ends, which is
both the moment nobody is watching and the moment the target has just been freed.
And it deploys the past: it pushes what its working tree held when it was armed,
not what is current when it fires. Killing the client does not recall a push that
has already been made; the server-side hook continues without it.

Never hand another user an identity-bearing URL. A `name=` query parameter
sets and persists the opener's identity; it is suitable for isolated test
browsers, not shared links.

## Documentation

Public documentation has two audiences:

- users need installation, project linking, formats, workspace interaction, and
  hosting guidance;
- developers need architecture, authority boundaries, protocols, configuration,
  and verification procedures.

Keep private incident timelines, internal task state, personal workflow, and
machine-specific paths out of public documentation. Preserve reusable technical
findings by stating the durable rule or mechanism directly.

The documentation map is [docs/README.md](docs/README.md). Exact CLI and MCP
arguments are defined by the running schemas and command help.

## Repository workflow

Use `rg` or `rg --files` for searches. Use `apply_patch` for hand edits.
Avoid destructive Git operations in a dirty checkout.

### Work lands by fast-forward merge. Cherry-picking onto `main` is forbidden.

Rebase your feature branch onto current `main` and fast-forward it. If it will
not fast-forward, rebase again. Do not cherry-pick to get around a rebase.

For a period, work was assembled onto `main` by cherry-pick instead. That is why
some landed work still fails an ancestry check: the change exists as two shas,
the author's and the copy, so `git merge-base --is-ancestor` reports it unmerged.
**Treat that as damage to be read around in old history, never as the way to
land anything.** Cherry-picking is what made merged-ness unanswerable — it broke
`git diff` the same way, and finished work sat unmerged for days because nobody
could tell what had landed.

Under fast-forward merging, whether something is merged is a question `git`
answers. That is the point of the rule.

Before a commit:

1. inspect `git status --short`;
2. inspect the exact diff;
3. run `git diff --check`;
4. run format, type, build, or targeted tests appropriate to the changed paths;
5. verify the requested behavior on its authoritative surface;
6. stage only the reviewed paths.

Do not call work complete merely because tests pass. Completion means the
original request is satisfied, unrelated behavior is preserved, and the
evidence covers the surface that matters.
