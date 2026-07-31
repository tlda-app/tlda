# Every environment variable tlda reads

Assembled by grepping the actual read sites — `process.env`, `import.meta.env`,
`$VAR`/`${VAR:-default}` in shell, `ENV` in Dockerfiles, `[env]` in `fly*.toml`,
`env:` in workflows — not from memory and not from what happens to be set on one
machine.

It lives here, beside `server.yaml` and `daemon.yaml`, because this is the
directory someone is in when they are changing one of these values. The keys
that have a YAML home are documented on the keys themselves; this file exists
for the ones that do not, and to make it checkable that nothing was missed.

**How to read the status column.** `→ server.yaml` means the value moved and the
environment variable is gone. `env (reason)` means it stays an environment
variable and why. Everything else is a knob or an identity that was never
deployment configuration and is not in scope for this migration.

---

## 1. Moved out of environment variables

These were `fly.*.toml` `[env]` entries. They are now keys in each deployment's
committed `config/deployments/<name>/server.yaml` or `daemon.yaml`. The old
variable names are gone — nothing reads them, and there is no alias.

| was | is now | notes |
|---|---|---|
| `TLDA_VOICE_BRIDGE_URL` | `server.yaml: deepgramBridgeUrl` | **Required.** Unset used to fall through to "does this server hold a Deepgram key", so a missing address presented as a missing feature. |
| `TLDA_VOICE_DIRECT_URL` | `server.yaml: deepgramDirectUrl` | Optional; absent = the browser uses the same-origin proxy. Was never set anywhere. |
| `TLDA_UPLOAD_DIR` | `server.yaml: uploadDir` | Absent = `~/.config/tlda/uploads`. |
| `TLDA_NO_AUTH` | `server.yaml: authDisabled` | Was a `'1'` string compare; now a boolean. |
| `TLDA_FLEET_SERVER` | `server.yaml: tokensFromEnvironmentOnly` | **Renamed, because the old name was wrong.** The server process read this URL *only* as a boolean "am I a hosted deploy, so take tokens from secrets and not from `tokens.json`". `/api/fleet-config` never read it — that comes from `daemon.yaml`'s `database`. The entrypoint's other use of it, templating `daemon.yaml`, is gone with the templating. |
| `TLDA_ENV` (per deployment) | `daemon.yaml: environments.default` | Still exists as a per-run override (`tlda --env <name>`), but no longer carries a deployment's identity. No `fly*.toml` sets it. |

## 2. Stays an environment variable — and why

| name | why it cannot move |
|---|---|
| `TLDA_DEPLOYMENT` | Names which directory under `config/deployments/` to install. A pointer cannot live inside the thing it points at. |
| `TLDA_CONFIG_DIR`, `TLDA_DAEMON_CONFIG_DIR` | Same bootstrap reason one level down: they say *where* `server.yaml`/`daemon.yaml` are. |
| `PORT`, `NODE_ENV`, `HOME`, `PATH`, `USER`, `TMUX`, `TMUX_PANE` | The platform sets these before the app runs. |
| `TLDA_TOKEN`, `TLDA_TOKEN_RW`, `TLDA_TOKEN_READ` | Secrets (`fly secrets`). A token in an image layer is a token in the repository. |
| `DEEPGRAM_API_KEY` | Secret, and it belongs to the *bridge* process on the voice box, not to this server. |
| `TS_AUTHKEY`, `FEELINGS_RCLONE_CONF_B64`, `CODEX_AUTH_JSON` | Secrets consumed by the entrypoint before any app code runs. |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `MYSCRIPT_APP_KEY`, `MYSCRIPT_HMAC_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `OVERLEAF_TOKEN`, `TLDA_FRIEND_GIT_TOKEN`, `TLDA_FRIEND_GIT_REMOTE`, `GRAFANA_ADMIN_PASSWORD` | Secrets. |

## 3. Not deployment configuration — out of scope, listed so nothing looks missed

**Process identity** — injected by a spawner into the child it spawns. These are
inter-process arguments, not settings; there is no file they could live in
because they differ per process.

`FLEET_ID` · `FLEET_NAME` · `FLEET_LOCAL_ID` · `FLEET_MINT_ID` · `FLEET_HARNESS`
· `FLEET_DAEMON_KEY` · `FLEET_TMUX_SESSION` · `TLDA_MACHINE_ID` ·
`TLDA_SPAWN_MACHINE_ID` · `TLDA_USER` · `TLDA_BOT_NAME` ·
`TLDA_BOT_REQUESTED_NAME` · `TLDA_BOT_MACHINE_ID` · `TLDA_BOT_TMUX_SESSION` ·
`TLDA_BOT_PIDFILE` · `TLDA_BOT_IDFILE` · `TLDA_BOT_HEARTBEAT` ·
`CLAUDE_SESSION` · `CLAUDE_SESSION_ID` · `CODEX_THREAD_ID` · `CODEX_CI` ·
`AGENT_WIN` · `TLDA_DEV_CLI` · `GIT_AUTHOR_NAME` · `GIT_AUTHOR_EMAIL` ·
`GIT_COMMITTER_NAME` · `GIT_COMMITTER_EMAIL`

**Sandbox and harness plumbing** — set by the fence and the harness launchers on
the child's environment, computed per launch.

`TLDA_PERMISSION_GRANT` · `TLDA_PERMISSION_LEASE_FILE` · `GIT_CONFIG_GLOBAL` ·
`GIT_CONFIG_NOSYSTEM` · `GIT_INDEX_FILE` · `TMPDIR` · `XDG_CONFIG_HOME` ·
`XDG_CACHE_HOME` · `XDG_DATA_HOME` · `XDG_STATE_HOME` · `xcrun_nocache` ·
`DEVELOPER_DIR` · `NODE_OPTIONS` · `NODE_EXTRA_CA_CERTS` ·
`NODE_TLS_REJECT_UNAUTHORIZED` · `TLDA_NODE_DNS_ALIAS_HOST` ·
`TLDA_NODE_DNS_ALIAS_ADDR` · `TLDA_NODE_DNS_ALIASES` · `GOOSE_DISABLE_KEYRING` ·
`GOOSE_MAX_TOKENS` · `GOOSE_TELEMETRY_OFF` · `OPENAI_API_KEY` · `OPENAI_HOST` ·
`CURSOR_AGENT_COMMAND` · `CLAUDE_HOME` · `CODEX_HOME` · `CODEX_SESSIONS_DIR` ·
`TERM` · the `*_SCRATCHPAD` / `*_SCRATCHPAD_ROOT` family

**Timeouts, intervals, and thresholds** — every one has a literal default in
code and none is set in any deployment. Moving them would be adding
configuration, which this task explicitly does not do.

`TLDA_STATUS_LINGER_MS` · `TLDA_AGENT_LIVENESS_REFRESH_MS` ·
`TLDA_HOT_OP_WARN_MS` · `TLDA_SLOWQUERY_MS` · `TLDA_WAKE_ACK_DEADLINE_MS` ·
`TLDA_WAKE_BREAKER_CAP_MS` · `TLDA_WEDGED_JOIN_MS` ·
`TLDA_SPAWN_LOGIN_DEADLINE_MS` · `TLDA_SPAWN_MAILBOX_DEADLINE_MS` ·
`TLDA_SPAWN_RESUME_ID_TIMEOUT_MS` · `TLDA_SPAWN_STARTUP_FAILURE_PROBE_MS` ·
`TLDA_SHELL_RESERVATION_TIMEOUT_MS` · `TLDA_PERMISSION_LEDGER_WRITE_TIMEOUT_MS`
· `TLDA_DAEMON_RPC_RECONNECT_GRACE_MS` · `TLDA_WS_HEARTBEAT_LAG_GRACE_MS` ·
`TLDA_WS_HEARTBEAT_LAG_COOLDOWN_MS` · `TLDA_TERMINAL_SIZE_POLL_MS` ·
`TLDA_SESSION_BACKFILL_STARTUP_DELAY_MS` ·
`TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS` · `TLDA_TASK_DOC_DISABLE` ·
`TLDA_SERVER_PERF_MAX_EVENTS` · `TLDA_TRANSPORT_PAYLOAD_MAX_BYTES` ·
`TLDA_TRANSPORT_OPERATION_*` (4) · `TLDA_JSONL_DISPLAY_REPLAY_MAX_BYTES` ·
`TLDA_LAG_PROFILER_*` (5) · `REAPER_ZOMBIE_MS` · `REAPER_INTERVAL_MS` ·
`REAPER_PREVIEW_IDLE_MS` · `TLDA_BUILD_PRIORITY` · `TLDA_PW_*` (10) ·
`TLDA_LOG` · `TLDA_LOG_LEVEL` · `LOG_LEVEL` · `TLDA_DEBUG` · `TLDA_OTEL` ·
`TLDA_OTEL_METRICS` · `TLDA_OTEL_SERVICE_NAME` · `OTEL_*` ·
`TLDA_DISABLE_PERMISSION_CLASSIFIER` · `TLDA_MCP_FLEET_ONLY` ·
`TLDA_DAEMON_LAUNCHD_DOMAIN` · `TLDA_DAEMON_PROCESS_TITLE` · `TMUX_SOCKET` ·
`PROJECTS_DIR` · `TLDA_PROJECTS_DIR` · `TLDA_SRCDIR` ·
`TLDA_QUALIFICATIONS_FILE` · `TLDA_TLS_CERT` · `TLDA_TLS_KEY` ·
`TLDA_TLS_CERT_TAILNET` · `TLDA_TLS_KEY_TAILNET` · `TLDA_SYNC_SERVER` ·
`TLDA_SERVER` · `TLDA_FLEET_DB` · `FLEET_DB` · `FLEET_WEBHOOK_URL` ·
`CHROME_PATH` · `EDITOR_CMD` · `SKILLS_SRC` · `PLAYWRIGHT_CLI_BIN` ·
`TLDA_DEV_DAEMON` · `TLDA_DEV_SERVER` · `TLDA_COMP_WORDS` · `MODEL` · `OPT` ·
`TLDA_GIT_USER_NAME` · `TLDA_GIT_USER_EMAIL` · `TS_HOSTNAME` ·
`FEELINGS_*` (5) · `TLDA_FRIEND_PROJECT` · `TLDA_FRIEND_GIT_URL` ·
`TLDA_AGENT_CONFIG_TGZ_B64`

**Build-time and client-side** — baked into the SPA bundle by Vite, not read by
any server: `BASE_URL` · `VITE_BASE_PATH` · `VITE_SYNC_SERVER` ·
`VITE_SERVER_HOST` · `VITE_SERVER_PORT` · `VITE_TLDA_URL` · `VITE_HMR` ·
`TLDA_VITE_HTTP` · `TLDA_VITE_PROXY_ACTIVE_CONFIG`

**Telemetry stack** — `telemetry/stack.sh` runs Grafana and Prometheus, which
are separate services with their own configuration: `GRAFANA_*` (10) ·
`PROMETHEUS_*` (2) · `GF_AUTH_ANONYMOUS_*` (2) · `INFINITY_PLUGIN_ID` ·
`TLDA_FLEET_URL` · `XDG_CONFIG_HOME`

**Test-only** — set by test harnesses to isolate a run: `TLDA_TEST_DEBUG` ·
`TLDA_FLEET_DB` · `TLDA_QUALIFICATIONS_FILE` · `NODE_TLS_REJECT_UNAUTHORIZED`
(13 test files) · `TLDA_CONFIG_DIR` / `TLDA_DAEMON_CONFIG_DIR` in fixtures

## 4. One thing worth knowing

`server/unified-server.mjs` reads a repository-root `.env` file at startup and
copies every `KEY=value` line into `process.env` for keys that are not already
set. Any variable in this document can therefore also arrive from that file, and
its contents are not in the repository — so it is not statically enumerable and
does not appear above. It is the one remaining way a value can reach the server
from somewhere nobody is looking.
