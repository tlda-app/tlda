# `tlda-dev serve --sandbox` isolates the server; the `project` verbs do not follow it

Measured 2026-09-12, 17:40–18:10 EDT, on the mini, worktree
`~/worktrees/build-card-visible` at `eca57bfcf`, trying to make a build card
appear on a disposable project so it could be photographed.

**Why this is written down rather than worked around.** Skip, 2026-09-12: *"if
exercising the tools isnt part of how you work the fking bugs all fall to me."*
Every step below is the supported path failing, not a shortcut failing.

## What the tool says it does

`tlda-dev serve --help`:

> `--sandbox` also brings up a fleet-daemon wired ONLY to this sandbox server
> (it literally cannot reach prod). … Isolated (own projects/DB/chat).

It does bring that up. The preview served 200 on
`https://<host>:5190`, it has its own `fleet.db`, its own `classroom.db` and its
own daemon under the environment `dev-preview-build-card-visible`.

## What happened when I tried to put a project into it

Four attempts, in order.

**1. `tlda-dev project link` from a plain directory → went to production.**

```
cd ~/worktrees/build-card-visible-proof
tlda-dev project link build-card-proof main.tex
  → Created project "build-card-proof".
  → Viewer: https://tlda-fly.cormorant-matrix.ts.net/?project=build-card-proof
```

The sandbox was up at the time. Nothing in the output says which server it
chose; the viewer URL is the only tell, and it names the live box.

**2. `tlda-dev project list` from inside the worktree → also production.** It
listed the real project set. `serve status` from that same directory correctly
answers `preview: up (build-card-visible)`, so the worktree-relative resolution
works for `serve` and not for `project`.

**3. `--server <sandbox>` → the create and the push went to different servers.**

```
tlda-dev project link bcv-card-proof main.tex --server https://<host>:5190
  → Created project "bcv-card-proof".
  → Error: Project "bcv-card-proof" not found
```

Two lines apart, about the same project, in the same command. The create reached
the sandbox; the daemon push reached the live daemon, where that project does not
exist. **`--server` moves the HTTP target and not the daemon**, and the failure
surfaces as a not-found rather than as a mismatch.

**4. `TLDA_ENV=dev-preview-build-card-visible` + `--server` → hung.** No output,
no error, killed at four minutes.

## What it costs

There is no established way to put a project into a `--sandbox` preview and build
it, so **the sandbox cannot exercise anything downstream of a build** — build
cards, build failures, lint findings, the change summary. Those are exactly the
surfaces whose defects have been invisible.

It also means an agent reaching for the isolated environment lands on production
without being told. Attempt 1 created a project on the live box in one command
that read as local. It is still there, deliberately: nothing here deletes
anything, and it is the evidence.

## A second, separate thing found on the way

`tlda-dev serve --real-fleet` did **not** give the preview the real fleet, at
least when run with `--no-build` over a tree that had previously been served with
`--sandbox`. The preview came up carrying the sandbox roster — a chat pane
pointed at a real agent rendered the app's own verdict, **"⚠ Filter matches no
known agents"** — while panes seeded for that environment were pointed at
`teacher-84` and `grammar-92`.

Not chased further, and stated as what was observed rather than as a diagnosis:
the sandbox state may simply persist across a restart that does not rebuild.

## The check that separated "rendered wrong" from "nothing arrived"

Worth keeping, because it is the trap in `AGENTS.md` §"A browser is a last
resort" — *they set up environments in which nothing happens and then are like,
oh, nothing's happening.*

The DOM query asked for two numbers, not one: the count of `.build-result-card`
**and** the count of plain `Build failed — ` text in the same panes. Both came
back `0`. One card and zero lines would have meant success; zero cards and one
line would have meant the renderer was not reached; **zero and zero means the row
never arrived**, and only the second number distinguishes that from a rendering
defect.
