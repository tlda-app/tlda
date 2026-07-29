# Hosting tlda

tlda can be served privately to friends and collaborators or deployed as the
project's live Fly application. In both cases, clients select one complete named
environment and the server sits behind an explicit access boundary.

## The configuration shape

Each entry in `~/.config/tlda/daemon.yaml` under `environments.values` is a
complete `{ database, store, licenseKey }` record. `database` selects
fleet/chat/agent state; `store` selects document assets and shape sync. Choose
an entry with `environments.default`, `--env <name>`, or `TLDA_ENV=<name>`.

Do not manually compose a deployment from separate URL variables. The internal
`TLDA_SYNC_SERVER` value used by agent launch harnesses is not a hosting
interface.

## Private hosting for friends

1. Install tlda, Node, and the TeX build dependencies on the serving machine.
2. Define a named environment whose database and store axes point at that server.
3. Start the server with `tlda server start`.
4. Start exactly one `tlda daemon start --env <name>` for each environment
   whose source trees or agent sessions the machine owns.
5. Link a history-backed document with `tlda project link`, then use
   `tlda project share <name>` to print the reachable viewer URL.

When the configured server is already remote, `tlda project share` uses that origin.
For a local server it chooses, in order, an active Tailscale Funnel URL, a
Tailscale address, or a private LAN address. It refuses to present localhost as
a usable URL for another machine.

### Tailscale boundary

The preferred private setup is a tailnet. Run the application open inside that
private network with `TLDA_NO_AUTH=1`; the tailnet is the authentication
boundary. `tailscale serve` can put the local server behind the machine's valid
`.ts.net` HTTPS name.

### Invite a collaborator

Choose the collaborator's level before sending the project. The same levels are
described from the collaborator's side in
[Join a project](../README.md#join-a-project).

| Level | Host provides | Collaborator does |
| --- | --- | --- |
| **Browser collaborator** | Reachable project URL, network access when required, build environment, and agents | Accept the network invitation, open the URL, choose an identity, and work in the browser |
| **Local author** | Browser access plus the repository remote and ordinary Git permissions | Install tlda, clone the repository, link the checkout, and edit locally |
| **Local agent operator** | Local-author access plus the named tlda environment | Run a daemon for that environment and configure MCP in the paper directory |

For a browser collaborator on a private deployment:

1. Add the collaborator to the tailnet or other authenticated network.
2. Link the intended local or remote-backed project.
3. Open the real project and verify source editing, Yjs synchronization,
   persistence after reload, a successful rebuild, version history, and any
   configured remote push.
4. Run `tlda project share <name>` and confirm that the printed URL is reachable
   through the selected boundary.
5. Send the collaborator the project URL and any project-specific handoff or
   working document.

At that level, the collaborator installs nothing besides the private-network
client when one is required. They use the browser source editor and the host's
agents. Do not ask them to clone the repository, install tlda, or configure a
daemon unless they are deliberately moving to one of the local levels.

For a local agent operator, provide the name of the complete environment rather
than separate database and store URLs. In their paper directory they run:

```bash
tlda daemon start --env <host-config-name>
TLDA_ENV=<host-config-name> tlda config mcp-setup
```

Exactly one daemon may watch that environment on their machine.

### Funnel boundary

Funnel makes the selected `.ts.net` URL public. tlda's tokens protect ordinary
HTTP viewer routes, but not every fleet and daemon channel. They are not a
server security boundary. Use Funnel only behind an authenticating proxy or
when every reachable agent runs inside a locked-down container that cannot
reach anything you care about. Check the actual URL with
`tailscale funnel status`.

Never expose the standard server port publicly without an authenticated network
or proxy boundary. The application deliberately includes terminal and
agent-control surfaces.

### Providing agents for browser-only collaborators

A collaborator using only the browser can still work with agents, but those
agents must run on a machine whose daemon connects to the same tlda server. The
operator can provide that machine; it does not have to be the collaborator's
computer.

The repository's Fly-for-friends path uses two Fly applications:
`Dockerfile.live` runs the viewer, project build, and fleet server, while
`Dockerfile.agent` with `scripts/fly-entrypoint-agent.sh` runs an outbound-only
daemon and Codex agents. The agent application keeps Codex and tlda state on a
volume, clones the friend's Git repository into its work directory, and seeds
Codex authentication from a Fly secret.

`tlda-fly friend plan` and `tlda-fly friend up` generate this render/agent pair.

## The live Fly deployment

The authoritative live procedure remains `docs/live-deploy.md`. From a clean
main checkout, use the wrapper:

```bash
npm run deploy:live
```

The wrapper runs the preflight and build before `fly deploy -c fly.live.toml`.
The live image is defined by `fly.live.toml`, `Dockerfile.live`, and
`scripts/fly-entrypoint-live.sh`. The entrypoint mounts mutable projects, Yjs
state, and server fleet state on the Fly volume; writes the server's named
config; and, when `TS_AUTHKEY` is supplied, joins the tailnet and proxies HTTPS
to port 5176 with `tailscale serve`.

Do not substitute plain `fly deploy`, `fly.toml`, or the old `tlda publish`
snapshot path. After deploy, verify Fly status, `/health`, `/api/fleet-config`,
the build-info commit, and the actual browser-visible behavior being shipped.

## Optional services

tlda runs without either service below. Browser voice remains available without
Deepgram, and ordinary document collaboration works without LiveKit.

### Deepgram

Deepgram is an alternative voice backend that happens to work better than
browser voice. Create an API key in a Deepgram project, then give the tlda
server one runtime secret:

```bash
fly secrets set DEEPGRAM_API_KEY="<key>" --app <fly-app>
```

For a local server, export `DEEPGRAM_API_KEY` in the server process environment
instead. The key does not belong in `daemon.yaml` or client-side configuration.
The server exposes the Deepgram SDK bridge through its authenticated,
same-origin `/voice/deepgram-sdk` WebSocket; the bridge runs beside the server,
including on Fly.

Check setup without exposing the key:

```bash
curl -fsS https://<host>/api/voice/backends
```

A configured server includes `{"value":"deepgram-sdk","label":"Deepgram"}` in
the returned `backends` array, and the Settings voice-backend selector includes
Deepgram. Without the secret, that option is absent. On 2026-07-27 this check
passed on both project Fly environments; an end-to-end transcription was not
performed as part of this documentation audit.

### LiveKit

LiveKit enables the document's mic/camera room controls, spatial remote audio,
and remote video shapes. Create a LiveKit Cloud project (or provide an
equivalent self-hosted server) and obtain its WebSocket URL, API key, and API
secret. For this repository's Fly applications, put those three values in
`~/.livekit` and run:

```bash
scripts/set-livekit-secrets.sh <fly-app>
```

The script sends `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and
`LIVEKIT_API_SECRET` directly to Fly secrets. For another deployment, set those
three variables in the tlda server process environment.

Check setup without exposing credentials:

```bash
curl -fsS https://<host>/api/livekit/config
```

Success is `{"configured":true,"url":"wss://..."}`. Missing configuration
returns `{"configured":false,...}`, and the room controls cannot obtain a join
token. On 2026-07-27 configuration and token issuance were checked on both
project Fly environments; a two-participant media call was not performed as
part of this documentation audit.

## Multi-machine rule

The daemon is the bridge to files and sessions on its own machine. If a daemon
route is unavailable, operations needing that machine fail with 503; the server
must not process a same-named local path as a fallback. Exactly one daemon may
watch a given environment on one machine.
