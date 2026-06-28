# LiveKit deployment (tlda live room audio)

Ops deployment path for tlda's live multidirectional audio (v1 of the voice-classroom
plan, `scratch/voice-classroom-plan.md`). The app half (token route, client SDK, room
join UI, spatial Web-Audio layer) lives on the `livekit-room-audio` branch; **this doc
owns the server/credentials/deployment side**: where the LiveKit SFU runs, how the tlda
server gets its keys, and how to verify a room end-to-end.

LiveKit is plumbing: an Apache-2.0 WebRTC SFU you can run locally (`livekit-server --dev`),
self-host, or use on LiveKit Cloud — **same client code against any of them**. The only
thing that changes per environment is three values: URL, API key, API secret.

---

## The env contract (do not change without telling the app side)

The tlda server reads exactly three env vars and **never hardcodes the secret**:

| Var | Meaning | Dev value | Prod value |
|-----|---------|-----------|------------|
| `LIVEKIT_URL` | SFU signaling URL the client connects to | `ws://127.0.0.1:7880` | `wss://<your-project>.livekit.cloud` |
| `LIVEKIT_API_KEY` | API key (identifies the keypair) | `devkey` | from Cloud / your config |
| `LIVEKIT_API_SECRET` | API secret (signs JWTs) | `secret` (see note) | from Cloud / your config — **secret, never in git** |

Client never sees the key/secret. It calls two server routes (app-side):
- `GET /api/livekit/config` -> `{ url }` (the `LIVEKIT_URL`, safe to expose)
- `POST /api/livekit/token` -> a short-lived join JWT signed server-side with
  `LIVEKIT_API_SECRET`, scoped to one room + identity.

This mirrors tlda's existing "secrets stay server-side, client gets a scoped token" shape.

> **Keypair must match.** The API key/secret used to *sign* the join token (tlda server)
> must be the same pair the *SFU validates against*. With `livekit-server --dev` the
> built-in pair is **`devkey` / `secret`** (note: the secret is literally `secret`, not
> `devsecret`). If you want a different secret, start the SFU with an explicit keypair
> (`--keys "devkey: devsecret"` or a config file) — otherwise every join 401s with a
> token/secret mismatch.

---

## Dev path — local SFU (no account, no spend)

This is the plan's "self-host escape hatch" and the fastest loop for app development.

```bash
brew install livekit livekit-cli      # livekit-server + the `lk` CLI (both dep-free Go bottles)
livekit-server --dev                  # binds 127.0.0.1: ws/http 7880, RTC tcp 7881, udp 7882
                                       # built-in keypair: devkey / secret
```

Point the tlda server at it:

```bash
export LIVEKIT_URL=ws://127.0.0.1:7880
export LIVEKIT_API_KEY=devkey
export LIVEKIT_API_SECRET=secret      # the --dev default; match whatever the SFU runs with
```

### Verified two-client smoke (ops-side, no browser needed)

The `lk` CLI joins as a real participant, so you can prove the SFU end-to-end before any
client code. This is the smoke I run to certify an endpoint:

```bash
export LIVEKIT_URL=ws://localhost:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret
# make a 20s opus tone to stand in for a mic
ffmpeg -f lavfi -i "sine=frequency=440:duration=20" -c:a libopus tone.ogg
# alice publishes the audio track; bob auto-subscribes (run both, then inspect)
lk room join --room tlda-audio --identity alice --publish tone.ogg &
lk room join --room tlda-audio --identity bob --auto-subscribe &
sleep 8
lk room list                                  # expect Participants=2, Publishers=1
lk room participants list tlda-audio          # alice: tracks 1, bob: tracks 0
```

A passing run (verified 2026-06-27 against `livekit-server` 1.13.1):
- `lk room list` -> `tlda-audio  Participants=2  Publishers=1`
- alice published a `MICROPHONE` audio track; **bob's log shows `track subscribed
  {kind: audio, source: MICROPHONE, participant: alice}`** — i.e. two clients in one
  room, one talking, the other hearing.

### localhost vs a *shared* dev endpoint (the mixed-content gotcha)

`--dev` binds **127.0.0.1 / ::1 only**, so the local SFU is reachable only from the same
machine. Two constraints when you want the tlda viewer (not the `lk` CLI) to use it:

1. **Reachability** — to use it from the iPad/another machine, bind to the Mac's tailnet
   IP and advertise it: run with a config that sets `rtc.use_external_ip: true` and a
   `bind_addresses`/node IP on the tailnet, then `LIVEKIT_URL=ws://<tailnet-ip>:7880`.
2. **Mixed content (the real blocker)** — the tlda viewer is **https-only**. A secure
   (https) page **cannot** open an insecure `ws://` WebSocket; the browser blocks it. So
   from the real https viewer the SFU URL must be **`wss://`** (TLS). Options:
   - run the app page over `http://localhost` for pure-local browser proof (ws:// allowed
     there), **or**
   - put the SFU behind TLS — easiest is LiveKit Cloud (wss:// out of the box), or front
     the local SFU with a TLS terminator / `tailscale serve` on the tailnet.

For browser verification *from another device or the https app*, use the Cloud endpoint
(below) or a TLS-fronted SFU — not bare `ws://localhost`.

### Temporary shared dev endpoint — tailnet-TLS SFU (no account, no spend)

Stood up 2026-06-27 as a shared dev endpoint for headed verification, avoiding the
Cloud account dependency. Treat this as ops-managed proof infrastructure, not an app
dependency.

**Endpoint:** ask ops for the current `wss://...` URL, key, and secret. Earlier proofs
used an Air-hosted tailnet URL with key `devkey` and a 48-hex secret; do not assume that
specific machine or port is current.

How it's built:
- LiveKit runs plain on `127.0.0.1:7880` with a config (`livekit-dev.yaml`) that:
  - sets a real `keys: { devkey: <48-hex secret> }` (prod mode rejects short secrets),
  - **advertises the node's tailnet IP** for media: `rtc.node_ip: 100.78.98.69`,
    `use_external_ip: false`, TCP 7881 / UDP 7882.
- `tailscale serve --bg --https=8444 http://127.0.0.1:7880` puts a **tailnet-only** TLS
  front (real Let's Encrypt cert for the `.ts.net` name) over the WS signaling. Not
  funnel — no public exposure. Picked port 8444 to avoid the existing serve/funnel
  mappings (5176/5188/5189).
- **Signaling** rides the `wss://` serve proxy; **media** goes direct to `100.78.98.69`
  — so the testing device must be on the tailnet (the iPad/laptop already are, since they
  reach the tlda app over `cormorant-matrix.ts.net`).

Verified with the two-client `lk` smoke over `wss://`: `GET / -> 200`, Participants=2 /
Publishers=1, audio track published + subscribed. The cross-device media leg is proven by
the app-side headed browser run from a second tailnet device.

Teardown: `tailscale serve --https=<port> off` and stop the matching `livekit-server`
process. Per current machine policy, do **not** add launchd persistence on Air for this
dev SFU. If a durable shared endpoint is needed, move it to ops-managed test
infrastructure instead of deepening the footprint on Skip's personal laptop.

---

## Prod path — LiveKit Cloud (the plan's choice; needs Skip)

The round-2 decision in `scratch/voice-classroom-plan.md` is **"v1 audio = LiveKit, Cloud
for the prototype, self-host later."** Cloud gives a `wss://` endpoint with TLS, TURN,
and global edge for free on the dev tier — no SFU to babysit.

**Provisioning (one-time, requires Skip — it creates an external account):**
1. Sign in at https://cloud.livekit.io (Skip's account).
2. Create a project (e.g. `tlda`). Cloud assigns a URL like `wss://tlda-xxxx.livekit.cloud`.
3. Under **Settings -> Keys**, create an API key -> get `API Key` + `API Secret`.
4. Hand those three values to ops; **never commit them**.

Ops then sets them as Fly secrets (see plumbing below). The app code is unchanged — only
the three env values differ from dev.

> I (ops) deliberately do **not** create the Cloud account or keys myself — that's an
> external account/billing action that's Skip's call. I provision Fly secrets and verify
> the smoke once the three values exist.

### Self-host-on-Fly alternative (later / if avoiding Cloud)

Possible but heavier — documented so the tradeoff is explicit:
- LiveKit needs **UDP** for media (default 7882). Fly supports UDP but it's fiddly and
  needs a dedicated IP; the TCP/TURN fallback (7881) must be configured for clients that
  can't do UDP.
- **TLS** is required (wss://) for the https viewer — terminate at Fly or run LiveKit's
  built-in TLS with a real cert.
- A **TURN** server (LiveKit has one built in) is needed for restrictive/symmetric-NAT
  networks; TURN-over-TLS on 443 is the most firewall-friendly.
- Runs as the `livekit/livekit-server` container; config via `LIVEKIT_KEYS` env or a
  mounted `config.yaml`.

This is a real project, not a one-liner. Recommend Cloud for the prototype and revisiting
self-host only if Cloud cost/latency/privacy becomes a problem.

---

## Secret plumbing — Fly (no hardcoded secrets)

The live tlda server is the Fly app `tldraw-sync-skip` (deployed via
`fly deploy -c fly.live.toml`, see `docs/live-deploy.md`). Set the LiveKit creds as Fly
secrets — they're injected as env at runtime, never baked into the image or git:

```bash
fly secrets set -a tldraw-sync-skip \
  LIVEKIT_URL='wss://tlda-xxxx.livekit.cloud' \
  LIVEKIT_API_KEY='<key>' \
  LIVEKIT_API_SECRET='<secret>'
# setting secrets triggers a rolling restart so the server picks them up
fly secrets list -a tldraw-sync-skip      # shows names + digests, never values
```

The server reads `process.env.LIVEKIT_*` (same names as dev). No fallback, no default
secret — if the vars are unset, the token route should 503 (`LiveKit not configured`)
rather than sign with a guessed key. For local dev, export the three vars in your shell
or your local `~/.config/tlda` env, **not** in a committed file.

---

## Operational constraints

**Networking / TURN / TLS**
- Ports: signaling `wss` 443 (Cloud) or 7880 (self-host); media UDP 7882 (preferred),
  TCP 7881 fallback. Cloud handles all of this.
- The https tlda viewer requires **wss://** — plain `ws://` is blocked as mixed content
  except on `http://localhost`.
- Restrictive networks (corp/VPN, symmetric NAT) need **TURN**; Cloud provides TURN-over-
  TLS on 443 automatically. Self-host must enable LiveKit's embedded TURN.

**Recording / egress**
- Server-side recording uses **LiveKit Egress** (separate component). On Cloud it's a
  toggle (metered); self-host runs the `livekit/egress` container, which needs its own
  storage target (S3/GCS/local) and is heavier than the SFU. Per the plan, v1 recording =
  Egress for audio + tlda's own timestamped store-diffs for canvas, replayed on one clock.
- Not needed for the live-audio MVP — defer until live two-way is solid.

**Credential rotation**
- Rotate by creating a new key in Cloud (or new `LIVEKIT_KEYS` entry self-host), updating
  the Fly secret, and deleting the old key. LiveKit supports multiple active keys, so you
  can roll without downtime: add new -> deploy -> revoke old.
- Join tokens are short-lived JWTs (set `--valid-for` / `ttl` minutes, not hours) signed
  per-join, so a leaked token expires fast; the long-lived secret is the thing to guard,
  and it lives only in Fly secrets + Skip's local env.

**Cost note**
- Cloud dev tier is free for prototype-scale usage; egress/recording and high
  participant-minutes are the metered axes. Watch participant-minutes the way we watch
  transcription cost — keep rooms torn down when idle (LiveKit auto-closes idle rooms
  after a departure timeout, seen in the smoke).
