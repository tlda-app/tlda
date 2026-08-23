# Where the night ended — 2026-08-23 02:05 EDT

**Superseded everything this file said earlier.** It was a pre-deploy window note
and it described a stop that no longer applies. Re-checked against `main` and the
deployment at the moment of writing, per §"A disposition is as of now".

| | |
|---|---|
| deployed | **`a2adffdff`**, verified serving, `/api/health` ok, store up |
| `main` | ahead by **docs only** — checked by path, nothing runtime unshipped |
| load | 4.5, from 15.0 at 22:35 |

## Shipped and verified on the box

- **A LaTeX project's figures never reached the server** when referenced from a
  subfile deeper than the document root. `shared/tex-deps.mjs` resolved against
  the *including* file; LaTeX resolves against the compilation directory. The two
  disagreed **in both directions** — a figure that did arrive still failed to
  compile. Fixed; the affected project went from never having built to 155 pages
  with figures rendering.
- **A failed build deleted its own log**, so the app said `error` and `Clean.`
  about the same build. Fixed, plus `logMissing` so an empty error list stops
  meaning two things.
- **A failed format dump reported the shell command** instead of the LaTeX error.
- **Editing in the browser never synced** — `WrongHead`, rejected silently.
- **A mint that rotated told nobody**, and the success line printed the tmux
  session rather than the agent name — two uniquifiers that rotate differently.
- **The notification spec** (`docs/notifications-and-liveness.md`): the daemon
  sideband, the server's wake queue, its drain and the circuit breaker are gone.
  The server reports one of four symptoms and chooses nothing; the daemon decides.
  Ack timeout is `5s` in `server.yaml`.

## What it cost, so nobody has to rediscover it

**Two live bugs shipped in consecutive commits on the notification path.** The
first killed two agents — one of them Skip's writing agent — by killing a session
and then failing to name it to `wake`. It self-corrected in about a minute
*because* the daemon's `ensure-process` is idempotent, which is the property the
spec insists on. The second made the remedy inert for ~35 minutes.

**Both were caught by a log line, not a test** — one added deliberately before
anything was allowed to delete that path, because `rpcNotifyAgent` logged nothing.
That is the argument for instrumenting a path *before* removing it.

**The claim that shipped too early:** the spec's daemon table has two rows and
only one was verified. The untested row is the one that shipped broken.

## Open, recorded rather than guessed

1. **The MCP half of the wire is not live for existing agents** — the nack needs
   each agent's MCP to restart.

   **The trigger I first set — "wait for the first `channel-silent`" — could never
   have fired, and the positive control is what showed it.** Measured 06:57Z, all
   `notification-symptom` lines since the remedy went live:

   ```
   419 lines total
   247  fleet:dev
   the rest  fleet:dev-probe-*, fleet:mcp-probe-*
   real agents  ZERO
   control: login-broken, notify-ship and advocate-3-2 all appear in the same
            log window, just never in a symptom line
   ```

   **Every one of those is an agent with no MCP socket, which can only ever emit
   `no-channel`.** So the zero was consistent both with the fleet being healthy
   and with nothing in the corpus being *able* to express the value — and I read
   it as the first. A real agent with a socket that acks normally produces no
   symptom at all, so the condition I was waiting for had no producer.

   **The corrected trigger: any `notification-symptom` line for an agent that is
   not `dev` and not a probe.** That can actually occur — it is what a real
   agent's MCP wedging looks like — and it is the case the nack exists to tell
   apart from a refusal. Until then the nack has no work to do, which remains a
   good reason to defer and is now a reason with an expiry that can arrive.
2. **`chat` refuses a routeless recipient; `delegate` accepts one silently** and
   creates a task that can never be delivered. In the spec's own unsettled list.
   `delegate` *does* notify a live recipient — control run, tagged notification.
3. **`qynth-advocate` has no `permission_grants` row**, so the fleet cannot wake,
   restart or type into it. Operator-only to fix; Skip has been told.
4. **Stored status disagrees with the column**, three times in one night: a seat
   `awake` with no process, a `dead` fixture whose metadata read `hibernating`,
   and `last_seen` refreshed by the status *write* rather than by the agent.
5. **The testing `todd` stopped at 01:37** — see
   `scratch/bot-name-rotation-deadlock.md`, recorded as a correlation only.

## Standing instruction that outlived the night

His words: **"fixed means it implements my spec and works"** — not deployed, not
green, not merged. And **write the revert criterion before the push**, because
afterwards "fix forward" and "protecting the work" are indistinguishable and the
author always has the better-sounding account.
