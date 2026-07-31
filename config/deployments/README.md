# Deployment configuration

One directory per hosted deployment, each holding the `server.yaml` and
`daemon.yaml` that deployment runs with. `scripts/fly-entrypoint-live.sh`
installs the directory named by `TLDA_DEPLOYMENT` into `~/.config/tlda/` on
boot, and refuses to start if that directory is missing.

These files used to be assembled at boot from environment variables in the
`fly.*.toml` `[env]` blocks, with shell defaults filling in whatever was unset.
That is how a live box ran for an evening with no Deepgram bridge configured:
the value was absent, the fallback absorbed it, and Deepgram simply stopped
appearing in the voice picker with no error anywhere. Here, a wrong value is a
diff and a missing one is a startup failure that names the key.

The `[env]` blocks now carry only what cannot live in a file:

- `TLDA_DEPLOYMENT` — which directory here to install. A pointer cannot live
  inside the thing it points at.
- `PORT`, `NODE_ENV` — the platform sets these before the app runs.
- Secrets (`TLDA_TOKEN_READ`, `TLDA_TOKEN_RW`, `DEEPGRAM_API_KEY`, `TS_AUTHKEY`,
  `FEELINGS_RCLONE_CONF_B64`) — these come from `fly secrets` and are never
  written to a file in the image.

`TLDA_ENV` is no longer set per deployment: each `daemon.yaml` below declares
its own `environments.default`, which is the same value in the place that owns
it. It remains a per-run override for local use (`tlda --env <name>`).

The `tlda-fly friend up` flow writes a directory here for each friend's render
box, so a friend deployment is as visible as the built-in ones.
