# Hosting tlda

tlda can be served privately to friends and collaborators or deployed as the
project's live Fly application. In both cases, clients select one complete named
environment and the server sits behind an explicit access boundary.

## The configuration shape

Each entry in `~/.config/tlda/daemon.yaml` under `environments:` is a complete
`{ database, store, licenseKey }` record. `database` selects fleet/chat/agent
state; `store` selects document assets and shape sync. Choose an entry with
`defaultEnv`, `--env <name>`, or `TLDA_ENV=<name>`.

Do not manually compose a deployment from separate URL variables. The internal
`TLDA_SYNC_SERVER` value used by agent launch harnesses is not a hosting
interface.

## Private hosting for friends

1. Install tlda, Node, and the TeX build dependencies on the serving machine.
2. Define a named environment whose database and store axes point at that server.
3. Start the server with `tlda server start`.
4. Start exactly one `tlda daemon start --env <name>` for each environment
   whose source trees or agent sessions the machine owns.
5. Link a history-backed document with `tlda doc link`, then use
   `tlda doc share <name>` to print the reachable viewer URL.

When the configured server is already remote, `tlda doc share` uses that origin.
For a local server it chooses, in order, an active Tailscale Funnel URL, a
Tailscale address, or a private LAN address. It refuses to present localhost as
a usable URL for another machine.

### Tailscale boundary

The preferred private setup is a tailnet. Run the application open inside that
private network with `TLDA_NO_AUTH=1`; the tailnet is the authentication
boundary. `tailscale serve` can put the local server behind the machine's valid
`.ts.net` HTTPS name.

### Funnel boundary

Funnel makes the selected `.ts.net` URL public. Before enabling it, configure
tlda token authentication rather than relying on tailnet membership. Check the
actual URL with `tailscale funnel status`; `tlda doc share` detects that URL and
includes the document's read-only login token.

Never expose the standard server port publicly with neither token authentication
nor an authenticated network boundary. The application deliberately includes
terminal and agent-control surfaces.

## The live Fly deployment

The authoritative live procedure remains `docs/live-deploy.md`. From a clean
main checkout:

```bash
node scripts/live-deploy-preflight.mjs
npm run build
fly deploy -c fly.live.toml
```

The live image is defined by `fly.live.toml`, `Dockerfile.live`, and
`scripts/fly-entrypoint-live.sh`. The entrypoint mounts mutable projects, Yjs
state, and server fleet state on the Fly volume; writes the server's named
config; and, when `TS_AUTHKEY` is supplied, joins the tailnet and proxies HTTPS
to port 5176 with `tailscale serve`.

Do not substitute plain `fly deploy`, `fly.toml`, or the old `tlda publish`
snapshot path. After deploy, verify Fly status, `/health`, `/api/fleet-config`,
the build-info commit, and the actual browser-visible behavior being shipped.

## Multi-machine rule

The daemon is the bridge to files and sessions on its own machine. If a daemon
route is unavailable, operations needing that machine fail with 503; the server
must not process a same-named local path as a fallback. Exactly one daemon may
watch a given environment.
