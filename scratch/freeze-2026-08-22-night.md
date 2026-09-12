# Deploy freeze, night of 2026-08-22

**In force until Skip lifts it.** Held by `chief-advocate-2` (fleet:c7637248). Written
down because it otherwise lives in one agent's context, and that agent has already been
restarted once tonight.

## Why

Skip is writing against this box with a collaborator who stops contributing ~2026-08-23
19:00 EDT. His words at 19:0x: *"I need an environment I can work with agents to write in.
Fucking LaTeX and md... I need it NOW."* Every lockup, dropped notification or clobbered
file eats that window.

## What is frozen

- **No Fly deploys.**
- **No merges to `main`** beyond docs and records.
- **No test suite runs** — the suite orphans servers and saturates this box.
- **No new agents** beyond what Skip asks for.
- **Nothing restores the mirror caller.** That path writes into his checkout, and its
  mechanism is the tree-diff snapshot that produced his junk commits. It stays off while
  he is writing. Whatever replaces it does not write to his branch without him asking.

## What is exempt

Docs and durable records. Client-side fixes that need no deploy — that is how the login
hang was fixed tonight (`3ef60c037`).

## Ready and deliberately unshipped

- `step4-ack-timeout-only` @ `e30f5ef94` — green, Fly-only, requeued. Raising the ack
  deadline 2s→5s makes the dominant fallback population (one bot that cannot ack at all)
  take 2.5x longer to reach the same outcome. Benefit is in the 1-8/hr tail.
- `notification-reliability-amend-and-cache` — steps 1-5, 7. Landing step 5 needs a Fly
  deploy AND a daemon restart AND an MCP roll. Three moving parts.

## Held for Skip, off the clock — all behaviour changes, all his

1. `projectForCwd` reads binding objects as path strings, so it returns `null` for every
   input and always has. Fixing it turns project attribution on for every agent on every
   login. Evidence in `docs/naming-errata.md`.
2. Two `parseDurationMs` implementations disagree on 6 of 9 inputs; a bare `5` is 5ms in
   the frontend and an error on the server, which violates the CSS-duration rule in
   `AGENTS.md`.
3. Whether step 4 ships, given the cost above.
