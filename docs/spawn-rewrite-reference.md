# Spawn rewrite — implementation reference (behavior map)

Companion to `spawn-rewrite-design.md`. This is the checklist of what
`bin/fleet-spawn.py` does, with line numbers and the **fragile fixes a naive
reimplementation will silently re-break**. Read the actual python at each cited line
before porting that piece — don't port from this summary alone.

## Daemon ↔ spawn boundary (what the node lib replaces)

- Daemon `rpcSpawn({agent_id,name,model,kind,cwd,doc,respawn,refresh,effort,mode,
  requestedCapability,callerRung})` — `bin/fleet-daemon.mjs:2455–2601`.
  - Builds args via `buildFleetSpawnArgs()` (`bin/lib/daemon-guards.mjs:139–174`).
  - Execs `tlda agent spawn-local [args]` → `fleet-spawn.py`
    (`fleet-daemon.mjs:2529–2550`). Env: `TLDA_MACHINE_ID` always; `TLDA_CONFIG` only
    if config-based; `TMUX:''`. `FLEET_SPAWN` env overrides the script (used by tests).
  - **Replace this exec with an in-process `import { spawn }`.** Keep the `rpcSpawn`
    RPC surface to the server identical.
- Failure today: detached `probeSpawnStartupFailure()` (`fleet-daemon.mjs:2424–2453`)
  captures the pane after `STARTUP_FAILURE_PROBE_MS`, regex-matches via
  `detectSpawnStartupFailureTranscript()` (`daemon-guards.mjs:102–137`) → sends
  `spawn-startup-failed`. Patterns: `codex-unsupported-model`, `goose-startup-error`,
  `account-auth-startup-error`. **Everything else → `[object Object]`.** The node
  `spawn()` must return/throw a typed error so this probe is the *second* check, not
  the only one.
- RPC plumbing: `RPC_HANDLERS` (`fleet-daemon.mjs:3661`), `handleRpc`
  (`:3671–3684`), WS dispatch (`:3831`).
- The `spawn-daemon-local-entry` branch (commit 4bea1050) is **only** a 127.0.0.1
  loopback HTTP listener (`daemon-local.json`, 0600, bearer token) that calls the same
  `rpcSpawn`. No node spawn engine. Optional to resurrect later; not load-bearing.

## fleet-spawn.py responsibilities (port targets)

### CLI surface — `main()` `fleet-spawn.py:1861–2956`
Flags: `name`, `--fresh`, `--refresh`, `--session <uuid>`, `--model`, `--cwd`,
`--effort`, `--mode`, `--spawn-capability {read,write,tlda-write,full}`, `--policy
{no-dev,cwd,tlda-projects,unsandboxed}`, `--kind {claude,goose,codex}`, `--agent-id`,
`--enroll`, `--no-attach`, `--dry-run`, `--list-models`, internal `--_dismiss-devch`.

### Spawn paths
- `fresh()` `:2520–2559` — new id. Sequence: ensure_server → identity → cwd resolve →
  harness/model → sandbox policy → native-tools guard → name-collision check →
  **ws_register shell=True (pre-register)** → build cmd → codex trust pre-seed →
  spawn_tmux → (codex) inject prompt.
- `refresh()` `:2660–2701` — same id, fresh session, `register refresh=True` (NO shell).
- `respawn()` `:2562–2657` — resume; **acquires fcntl wake-lock** (`:2602`,
  `acquire_wake_lock` `:2235–2261`) single-flight; `find_resume`; strip synthetic tail.
- `respawn_session()` `:2759–2856` — by JSONL/rollout uuid; `--enroll` mints id.

### Harness adapters `:1956–2149`
Interface methods: `owns_model, resolve_model, warn_model, build_cmd, fresh_label,
refresh_auto_dismiss, respawn_auto_dismiss, spawn_send_keys, find_resume,
adjust_resume_cwd, resume_id, after_resume_started, resume_not_found_is_error,
no_resume_message, list_models`.
- **Claude** `:2010–2054`: resume = scan `~/.claude/projects/**.jsonl` for own
  `Registered fleet:<id>`; `after_resume_started` = verify_session(2s) + inject_prompt;
  resume-missing = fatal; send_keys False.
- **Goose** `:2056–2091`: `resolve_goose_model` (alias or `vendor/model`); unverified →
  warn; no resume; send_keys False.
- **Codex** `:2093–2143`: `gpt|gpt55|codex→gpt-5.5`, `^gpt` typo-collapse; resume =
  scan `~/.codex/sessions/**/rollout-*.jsonl`; **send_keys True** (TUI); prompt `›`.
- Dispatch: `infer_harness_kind` `:2152`, `harness_for_spawn`, `harness_for_agent`.

### Identity / register `:449–495`
`ws_register()` → `{ws_api}/ws/fleet?agent=<id>`, message shape includes `type,id,
name,tmux_session,cwd,kind,shell?,machine_id?,session_id?,metadata{model,effort,
refresh,spawnPolicy{capability,policy},sandbox}`. Name-collision: `/api/check-name`
(`:841–852,2490–2517`). API resolution `:95–116`; **CONFIG_NAME stamping `:116–129`**
(agent MCP resolves same config, not URL — closes the 6/27 wrong-fleet bug).

### tmux `:346–398, 2311–2389, 2392–2485`
`sanitize_session_name`/`unique_session_name`; `spawn_tmux` respawn-pane-first then
new-session; window-size manual 120×40; send-keys path stages cmd in a temp script and
pastes `source <path>` (**MAX_CANON ~1KB overflow guard `:2363–2380`**); `inject_prompt`
(claude `❯`) / `inject_codex_prompt` (`›`) with dialog dismissal.

### Capability / fence / sandbox `:61–81, 865–1481`
4 rungs (`normalize_spawn_capability`); 4 policies; resolution precedence
`--policy>model>harness>global` (`:1152–1192`); `FENCE_GLOBALLY_DISABLED` override
(`:1164–1191`, only when not explicit). **Fence = build lease JSON
(`_fence_settings` `:1328–1481`) + invoke `fence --settings lease.json -- zsh -lc cmd`
(`wrap_sandbox_cmd`).** Port = JSON construction; the `fence` binary is untouched.
Codex sandbox modes `:1678–1719`. Capability→write-roots `:1819–1841`.

### Model registry `:187–327`
`MODEL_ALIASES` (claude), `GOOSE_MODELS`/`GOOSE_VERIFIED`, `CODEX_MODELS`,
`resolve_model`/`resolve_goose_model`, `--list-models` JSON `:2895–2904`,
`DEFAULT_MODEL=claude-opus-4-8[1m]`. **Down-payment already landed (a30f9d10):** dropped
`fable`, added `gpt55`, dropped `gpt-5.5` self-alias.

## The fragile fixes (DO NOT silently re-break)

1. **mkcert TLS for any https API** `:130–142` — not just localhost; else multi-machine
   pre-register TLS handshake fails silently → register timeout → ghost agent.
2. **DNS-alias NODE_OPTIONS preload** `:1521–1533,1763–1801` — fenced agents can't
   getaddrinfo MagicDNS; spawner pre-resolves tailnet IP and aliases it. Without it,
   fenced agents show `fleet WS: ✘`.
3. **Respawn-pane runtime guard** `:2331–2343` (`_session_has_runtime` `:2193–2232`) —
   never kill a live harness proc (death-loop). Check the process tree first.
4. **fcntl wake-lock** `:2235–2261` — single-flight respawn; concurrent wakes else
   double-launch. Node needs a real flock equivalent.
5. **Devchannels grace window** `:2267–2308` — don't trust "no dialog" for 8s; stale
   pre-repaint pane shows a stale `❯`.
6. **First `Registered fleet:` only** `:598–634,687–698` — match the agent's OWN id, not
   a child it spawned/read_terminal'd.
7. **Synthetic-tail strip** `:754–806` — drop CC's `<synthetic>` exit entries before
   resume or the API rejects the transcript (gh #58427).
8. **CONFIG_NAME stamping** `:116–129` — agent resolves the config NAME, not a URL.
9. **Goose XDG_DATA_HOME shared** `:1629–1638` — only XDG_CONFIG_HOME isolated, else the
   daemon can't read goose sessions → activity cards look idle.
10. **Codex nested-sandbox avoid** `:1686–1689` — when fenced, force codex
    danger-full-access (sandbox-exec inside fence fails).
