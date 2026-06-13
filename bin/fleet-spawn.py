#!/usr/bin/env python3
"""fleet-spawn — spawn or respawn fleet agents.

Usage:
  fleet-spawn <name>                  Respawn existing agent (resume most recent session)
  fleet-spawn --fresh <name>          Spawn a new agent
  fleet-spawn --refresh <name>        Fresh session, same fleet ID
  fleet-spawn --session <uuid>        Respawn by session UUID

Options:
  --model <model>    Model alias or claude-* ID (default: opus46)
  --cwd <path>       Working directory override
  --effort <level>   low|medium|high|xhigh|max
  --mode <mode>      Permission mode (plan, default, auto)
  --no-attach        Don't attach to tmux after spawning
  --enroll           With --session: mint new fleet ID for unregistered session
  --dry-run          Print what would happen
"""

import argparse
import json
import fcntl
import os
import re
import shlex
import ssl
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.request import urlopen, Request
from urllib.error import URLError
import websocket

DASH_PORT = os.environ.get("FLEET_DASH_PORT", "5176")
DASH_HOST = os.environ.get("FLEET_DASH_HOST", "127.0.0.1")
_tls_cert = os.path.expanduser("~/.config/tlda/localhost+2.pem")
_scheme = "https" if os.path.exists(_tls_cert) else "http"
API = f"{_scheme}://{DASH_HOST}:{DASH_PORT}"
_ca_path = os.path.expanduser("~/Library/Application Support/mkcert/rootCA.pem")
_ssl_ctx = None
if _scheme == "https" and os.path.exists(_ca_path):
    _ssl_ctx = ssl.create_default_context()
    _ssl_ctx.load_verify_locations(_ca_path)
DEFAULT_MODEL = "claude-opus-4-8[1m]"
REGISTER_PROMPT = "Call register() with the fleet MCP server. Then call my_task() to check for a pending task."


def register_prompt(name=None):
    """The register prompt, with the friendly name baked in so the agent
    registers under the name it was spawned with. Without this the agent has
    no clean source for its name and derives it from the tmux window
    (FLEET_TMUX_SESSION), which carries slot suffixes like ``-1b`` — that's how
    the friendly name gets corrupted to ``leverage?-1b``."""
    if name:
        return f'Call register(name="{name}") with the fleet MCP server. Then call my_task() to check for a pending task.'
    return REGISTER_PROMPT

MODEL_ALIASES = {
    "opus": DEFAULT_MODEL,
    "opus45": "claude-opus-4-5",
    "opus46": "claude-opus-4-6[1m]",
    "opus47": "claude-opus-4-7[1m]",
    "opus48": "claude-opus-4-8[1m]",
    "fable": "claude-fable-5[1m]",
    "fable5": "claude-fable-5[1m]",
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5",
}

# Goose-backed (non-Claude) models. Selecting one of these makes fleet-spawn
# launch the hard-sandboxed goose recipe instead of `claude` — same tmux,
# identity, register/my_task, and wake machinery; only the engine differs.
#
# Routed through OpenRouter (provider=openrouter), NOT DeepSeek-direct: goose's
# generic openai provider pointed at api.deepseek.com does not negotiate
# structured tool-calls with DeepSeek (the model emits them as text), so the
# agent can't invoke its tools. OpenRouter handles tool-calling correctly.
# Hence the OpenRouter-style model ids below.
# The reasoner (Skip's pick for the adversary seat) maps to the **r1-0528**
# snapshot, NOT plain `deepseek-r1`: verified 2026-06-13 that `deepseek/deepseek-
# r1` through goose emitted tool calls as TEXT in DeepSeek's native format
# (`function<｜tool▁sep｜>…`) — its OpenRouter provider didn't negotiate
# structured tool-calls — so the agent stalled. `deepseek/deepseek-r1-0528`
# routes to a tool-capable provider and emits real structured tool-calls through
# goose (verified live: register/my_task/read_doc/lookup_theorem all executed as
# tool calls). (If OpenRouter ever routes 0528 to a non-tool provider, the next
# hardening step is forcing `provider:{require_parameters:true}` — not needed so
# far.)
GOOSE_MODELS = {
    "deepseek": "deepseek/deepseek-chat",
    "deepseek-chat": "deepseek/deepseek-chat",
    "deepseek-v3": "deepseek/deepseek-v3.2",
    "deepseek-r1": "deepseek/deepseek-r1-0528",
    "deepseek-reasoner": "deepseek/deepseek-r1-0528",
    "deepseek-v4": "deepseek/deepseek-v4-pro",
    "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
    "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
}
GOOSE_BIN = "/opt/homebrew/bin/goose"
DEEPSEEK_RECIPE = os.path.join(
    os.path.dirname(os.path.realpath(__file__)), "..", "recipes", "fleet-deepseek.yaml")


def resolve_goose_model(model):
    """Return the concrete DeepSeek model id if `model` selects a goose-backed
    agent, else None (meaning: a normal Claude agent). Accepts the aliases above
    or a raw OpenRouter id (deepseek/…) so a respawn whose stored meta.model is
    already resolved still routes to goose."""
    if not model:
        return None
    if model in GOOSE_MODELS:
        return GOOSE_MODELS[model]
    if model.startswith("deepseek/"):
        return model
    return None

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)
TLDA_CLI = os.path.join(REPO_DIR, "cli", "tlda.mjs")
CONFIG_FILE = os.path.join(os.path.expanduser("~"), ".config", "tlda", "config.json")


def read_config():
    try:
        with open(CONFIG_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def tmux(*args):
    sock = read_config().get("tmuxSocket")
    return ["tmux", "-L", sock, *args] if sock else ["tmux", *args]


def sanitize_session_name(name):
    """Map an (expressive) friendly name to a safe tmux session token.

    tmux session names can't contain '.', ':', whitespace, or shell-unsafe chars
    — those break has-session / send-keys and the server's hibernate ("unsafe
    tmux session name"). The friendly name itself is unchanged and lives in the
    DB; only the derived session string is sanitized, so e.g. ``leverage?`` keeps
    its name but runs in session ``fleet-leverage``.
    """
    safe = re.sub(r"[^A-Za-z0-9_-]", "-", name or "")
    safe = re.sub(r"-+", "-", safe).strip("-")
    return safe or "agent"


def unique_session_name(base):
    """Append -2, -3, … if a DIFFERENT tmux session already holds the name, so
    two friendly names that sanitize to the same token don't share a session."""
    sess = base
    n = 2
    while subprocess.run(tmux("has-session", "-t", sess), capture_output=True).returncode == 0:
        sess = f"{base}-{n}"
        n += 1
    return sess


def resolve_model(model):
    if not model:
        return DEFAULT_MODEL
    if model in MODEL_ALIASES:
        return MODEL_ALIASES[model]
    if model.startswith("claude-"):
        return model
    raise ValueError(f"Unknown model: {model!r}. Valid: {', '.join(sorted(MODEL_ALIASES))}")


EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")


def resolve_effort(effort):
    """Validate an effort level, mirroring resolve_model's resolve-or-reject.
    Returns the level unchanged, or None when none was supplied. A typo used to
    pass straight to --effort and silently break the launch."""
    if not effort:
        return None
    if effort in EFFORT_LEVELS:
        return effort
    raise ValueError(f"Unknown effort: {effort!r}. Valid: {', '.join(EFFORT_LEVELS)}")


def resolve_spawn_cwd(cwd):
    """Resolve the directory a fresh agent launches in. Never `/`.

    The fleet-daemon runs under launchd with cwd `/`. When a spawn's project
    doesn't resolve, the daemon drops `--cwd`, and a bare `cwd or os.getcwd()`
    would then launch Claude in `/` — it hits the "trust this folder?" prompt,
    the pane exits, and the agent dies as a ghost row. Refuse `/` and fall back
    to the tlda repo so a spawn always lands somewhere real."""
    resolved = cwd or os.getcwd()
    resolved = os.path.abspath(resolved)
    if resolved == "/":
        return REPO_DIR
    return resolved


# ---- Server communication ----

def api_get(path):
    try:
        return json.loads(urlopen(f"{API}{path}", timeout=5, context=_ssl_ctx).read())
    except URLError as e:
        print(f"Error: server unreachable at {API} — {e}", file=sys.stderr)
        sys.exit(1)


def ensure_server():
    try:
        urlopen(f"{API}/api/state", timeout=2, context=_ssl_ctx)
        return True
    except URLError:
        pass
    if DASH_HOST not in ("127.0.0.1", "localhost"):
        print(f"Warning: server unreachable at {API}", file=sys.stderr)
        return False
    print("Starting tlda server...", file=sys.stderr)
    subprocess.run(["node", TLDA_CLI, "server", "start"], cwd=REPO_DIR,
                    capture_output=True, timeout=15)
    for _ in range(20):
        time.sleep(0.5)
        try:
            urlopen(f"{API}/api/state", timeout=1, context=_ssl_ctx)
            print("Server started.", file=sys.stderr)
            return True
        except URLError:
            pass
    print("Error: server failed to start.", file=sys.stderr)
    return False


def ws_register(fleet_id, name, tmux_session, cwd, model=None, effort=None, refresh=False):
    _ws_scheme = "wss" if _scheme == "https" else "ws"
    ws_url = f"{_ws_scheme}://{DASH_HOST}:{DASH_PORT}/ws/fleet?agent={fleet_id}"
    try:
        ws_opts = {"timeout": 5}
        if _ssl_ctx:
            ws_opts["sslopt"] = {"context": _ssl_ctx}
        ws = websocket.create_connection(ws_url, **ws_opts)
        msg = {"type": "register", "id": fleet_id, "name": name,
               "tmux_session": tmux_session, "cwd": cwd}
        meta = {}
        if model:
            meta["model"] = model
        if effort:
            meta["effort"] = effort
        if refresh:
            meta["refresh"] = True
        if meta:
            msg["metadata"] = meta
        ws.send(json.dumps(msg))
        try:
            resp = json.loads(ws.recv())
            if resp.get("error"):
                ws.close()
                print(f"[fleet-spawn] registration rejected: {resp['error']}", file=sys.stderr)
                sys.exit(1)
        except (json.JSONDecodeError, websocket.WebSocketTimeoutException):
            pass
        ws.close()
    except SystemExit:
        raise
    except Exception as e:
        print(f"[fleet-spawn] pre-register failed (non-fatal): {e}", file=sys.stderr)


# ---- Agent lookup ----


def _jsonl_path_to_cwd(jsonl_path):
    """Derive the original working directory from a JSONL file.
    Reads the first line's cwd field (most reliable), falls back to
    reconstructing from the Claude project directory name.
    """
    try:
        with open(jsonl_path, "r", errors="replace") as f:
            for i, line in enumerate(f):
                if i > 20:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                cwd = d.get("cwd")
                if cwd and os.path.isdir(cwd):
                    return cwd
    except OSError:
        pass
    # Fallback: reconstruct from project dir name by greedy path matching
    project_dir = os.path.dirname(jsonl_path)
    dirname = os.path.basename(project_dir)
    if not dirname.startswith("-"):
        return None
    parts = dirname[1:].split("-")
    path = ""
    for i, part in enumerate(parts):
        candidate = path + "/" + part
        if os.path.isdir(candidate):
            path = candidate
        else:
            # Try joining remaining parts with hyphens
            rest = "-".join(parts[i:])
            candidate = path + "/" + rest
            if os.path.isdir(candidate):
                return candidate
            break
    return path if os.path.isdir(path) else None


def find_valid_session(agent):
    """Find a session UUID that has a backing .jsonl file.
    Three-step lookup: DB primary → DB session_ids list → content scan of all JSONLs.
    Returns (session_id, cwd_from_jsonl) tuple."""
    import glob as _glob
    import re as _re

    projects_base = os.path.expanduser("~/.claude/projects")

    def _jsonl_path(uuid_str):
        hits = _glob.glob(os.path.join(projects_base, "*", f"{uuid_str}.jsonl"))
        return hits[0] if hits else None

    # Step 1: DB primary session_id
    primary = agent.get("session_id")
    if primary:
        p = _jsonl_path(primary)
        if p:
            return (primary, _jsonl_path_to_cwd(p))

    # Step 2: DB session_ids list
    session_ids = agent.get("session_ids") or agent.get("sessions") or []
    if isinstance(session_ids, str):
        try:
            session_ids = json.loads(session_ids)
        except Exception:
            session_ids = []
    for alt in reversed(session_ids):
        if alt != primary:
            p = _jsonl_path(alt)
            if p:
                print(f"  session_id {primary} has no .jsonl, falling back to {alt}", file=sys.stderr)
                return (alt, _jsonl_path_to_cwd(p))

    # Step 3: content scan — search all JSONLs for this agent's fleet ID
    fleet_id = agent.get("id")
    if not fleet_id or not os.path.isdir(projects_base):
        return None
    print(f"  scanning JSONLs for {fleet_id}...", file=sys.stderr)
    register_pattern = _re.compile(r'Registered (fleet:\w+)')
    candidates = []
    for project_hash in os.listdir(projects_base):
        project_dir = os.path.join(projects_base, project_hash)
        if not os.path.isdir(project_dir):
            continue
        for fname in os.listdir(project_dir):
            if not fname.endswith(".jsonl"):
                continue
            fpath = os.path.join(project_dir, fname)
            sid = fname[:-6]
            try:
                mtime = os.path.getmtime(fpath)
            except OSError:
                continue
            last_registered_id = None
            try:
                with open(fpath, "r", errors="replace") as f:
                    for line in f:
                        if "Registered fleet:" not in line:
                            continue
                        try:
                            d = json.loads(line.strip())
                            tur = d.get("toolUseResult")
                            if not tur:
                                continue
                            items = tur if isinstance(tur, list) else [tur]
                            for item in items:
                                text = item.get("text", "") if isinstance(item, dict) else str(item)
                                m = register_pattern.search(text)
                                if m:
                                    last_registered_id = m.group(1)
                        except (json.JSONDecodeError, AttributeError):
                            continue
            except OSError:
                continue
            if last_registered_id == fleet_id:
                candidates.append((sid, mtime, fpath))
    if candidates:
        candidates.sort(key=lambda x: x[1], reverse=True)
        best_sid, _, best_path = candidates[0]
        print(f"  found {len(candidates)} session(s) via content scan, using {best_sid}", file=sys.stderr)
        return (best_sid, _jsonl_path_to_cwd(best_path))

    return None


def strip_synthetic_tail(session_id):
    """Strip synthetic assistant entries from the tail of a session JSONL.

    CC writes model=<synthetic> entries on exit. On resume, CC uses their UUID
    message.id as previous_message_id → API 400 (expects msg_* prefix).
    GitHub issue #58427. We truncate these before resuming."""
    import glob as _glob
    import re as _re

    projects_base = os.path.expanduser("~/.claude/projects")
    hits = _glob.glob(os.path.join(projects_base, "*", f"{session_id}.jsonl"))
    if not hits:
        return
    fpath = hits[0]

    try:
        with open(fpath, "r", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return

    if not lines:
        return

    uuid_re = _re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    stripped = 0
    while lines:
        line = lines[-1].strip()
        if not line:
            lines.pop()
            stripped += 1
            continue
        try:
            entry = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            break
        if entry.get("type") == "assistant":
            msg = entry.get("message", {})
            model = msg.get("model", "")
            msg_id = msg.get("id", "")
            if "<synthetic>" in model or (msg_id and uuid_re.match(msg_id)):
                lines.pop()
                stripped += 1
                continue
        break

    if stripped:
        print(f"  stripped {stripped} synthetic entries from tail of {session_id}", file=sys.stderr)
        try:
            with open(fpath, "w") as f:
                f.writelines(lines)
        except OSError as e:
            print(f"  WARNING: failed to write stripped JSONL: {e}", file=sys.stderr)


def find_agent(name):
    agents = api_get("/api/store/agents")
    if name.startswith("fleet:"):
        return next((a for a in agents if a.get("id") == name), None)
    # Ignore dead agents: a killed agent must not claim its name and block a
    # fresh spawn. Matches /api/check-name and the server's findAgent, which
    # both filter dead — find_agent was the lone holdout, so a stale dead row
    # made `fresh()` refuse with "already exists".
    return next((a for a in agents if a.get("friendly_name") == name and not a.get("dead")), None)


def check_name_collisions(name):
    """Pre-flight against /api/check-name. Returns list of collision dicts
    (empty if available). Authoritative check is server-side; this is just
    fail-fast before we launch claude."""
    if not name or name.startswith("fleet:"):
        return []
    from urllib.parse import quote
    try:
        result = json.loads(urlopen(f"{API}/api/check-name?name={quote(name)}", timeout=5, context=_ssl_ctx).read())
        return result.get("collisions", [])
    except URLError:
        return []


def agent_meta(agent):
    meta = agent.get("metadata") or {}
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except Exception:
            meta = {}
    return meta if isinstance(meta, dict) else {}


# ---- Tmux ----

def build_claude_cmd(fleet_id, tmux_session, model, effort=None, mode=None,
                     resume_id=None, include_prompt=True, name=None):
    """Build the shell command string for claude inside tmux.

    When include_prompt=True (fresh spawn, refresh), appends the register prompt
    as a positional arg. When False (resume), omits it so Claude Code stays
    in interactive mode — the caller injects the prompt via tmux send-keys.

    `name` is the clean friendly name; it's passed both as FLEET_NAME and baked
    into the register prompt so the agent registers under it rather than the
    tmux window name.
    """
    parts = [f"FLEET_ID={fleet_id}", f"FLEET_TMUX_SESSION={tmux_session}"]
    if name:
        parts.append(f"FLEET_NAME={shlex.quote(name)}")
    parts.append("claude")
    if resume_id:
        parts.append(f"--resume {resume_id}")
    parts.append("--dangerously-load-development-channels server:tlda")
    parts.append(f"--model '{model}'")
    if effort:
        parts.append(f"--effort '{effort}'")
    if mode:
        parts.append(f"--permission-mode '{mode}'")
    if include_prompt:
        parts.append(shlex.quote(register_prompt(name)))
    return " ".join(parts)



def build_goose_cmd(fleet_id, tmux_session, model, name=None):
    """Build the shell command for a Goose-backed DeepSeek fleet agent.

    Mirrors build_claude_cmd's identity env (FLEET_ID/FLEET_NAME/TMUX) but
    launches the hard-sandboxed goose recipe instead of claude:
      - SANDBOX via an isolated `XDG_CONFIG_HOME` (recipes/goose-sandbox/) whose
        config.yaml disables ALL bundled platform extensions (developer=shell+fs,
        tom, apps, summon, …). So the recipe's tlda MCP is the agent's ONLY
        capability. We do NOT use `--no-profile`: verified 2026-06-13 that
        `--no-profile` ALSO disables the recipe's own extensions (the agent boots
        with zero tools and narrates tool calls as text — looked like "deepseek
        can't tool-call" but was really no-tools-loaded). The isolated-config
        approach keeps the sandbox while letting the recipe's extension load.
      - provider=openrouter: goose's OpenRouter provider reads OPENROUTER_API_KEY
        from the env and negotiates structured tool-calls correctly. (We do NOT
        use DeepSeek-direct via the openai provider: verified 2026-06-13 that
        deepseek-v4-{flash,pro} through goose's openai→api.deepseek.com path emit
        tool calls as TEXT instead of invoking them, so the agent can't act. And
        goose has no native `deepseek` provider — "Unknown provider" at runtime.)
      - --interactive keeps the session alive after the kickoff so the wake
        machinery (tmux send-keys) can drive it like a claude agent.
      - The register()+my_task kickoff lives in the recipe's `prompt:` field —
        goose forbids --text alongside --recipe. register() takes no name; the
        server names the agent from FLEET_NAME (set below), so the identity is
        correct without baking a name into a prompt.

    Key plumbing: the whole thing is wrapped in `zsh -lc` so it runs under a
    LOGIN shell. tmux's default-command is a non-login `/bin/zsh`, which sources
    neither ~/.zprofile nor ~/.zshrc — so OPENROUTER_API_KEY (which lives in
    ~/.zprofile) would otherwise be absent from the pane. The login wrapper
    sources the profile so goose finds the key in its env; the secret value
    never appears in this command string.
    """
    recipe = os.path.abspath(DEEPSEEK_RECIPE)
    sandbox_cfg = os.path.join(os.path.dirname(recipe), "goose-sandbox")
    parts = [
        f"FLEET_ID={fleet_id}",
        f"FLEET_TMUX_SESSION={tmux_session}",
        # FLEET_HARNESS=goose tells the tlda MCP this agent runs on goose, which
        # ignores the Claude-only channel notification — so the MCP delivers
        # incoming messages by send-keys'ing a nudge into this pane instead.
        "FLEET_HARNESS=goose",
        f"TLDA_SERVER={shlex.quote(API)}",
        f"TLDA_SYNC_SERVER={shlex.quote(API)}",
        f"XDG_CONFIG_HOME={shlex.quote(sandbox_cfg)}",
        "GOOSE_DISABLE_KEYRING=1",
        # Force telemetry off non-interactively. goose's first interactive run
        # otherwise blocks on a "share anonymous usage data?" consent prompt that
        # hangs boot (the config's GOOSE_TELEMETRY_ENABLED:false doesn't suppress
        # the PROMPT). GOOSE_TELEMETRY_OFF overrides the config and skips the ask.
        "GOOSE_TELEMETRY_OFF=1",
    ]
    if name:
        parts.append(f"FLEET_NAME={shlex.quote(name)}")
    parts.append(shlex.quote(GOOSE_BIN))
    parts.append("run")
    parts.append(f"--recipe {shlex.quote(recipe)}")
    parts.append("--params provider=openrouter")
    parts.append(f"--params model={shlex.quote(model)}")
    # Stamp the goose session with a fleet-derived NAME so the daemon can map a
    # fleet agent to its goose sqlite session exactly (sessions otherwise carry
    # no fleet identity — auto name + shared working_dir = ambiguous with >1
    # goose agent per dir). Drives the turn-end auto-kick's done-signal and the
    # activity-card source. `--name` is a freeform label (safe + queryable);
    # `--session-id` is avoided because goose expects its own id format there.
    # Sanitize the colon: FLEET_ID is `fleet:<hex>`, goose --name may choke on `:`.
    session_label = "fleet-" + str(fleet_id).split(":")[-1]
    parts.append(f"--name {shlex.quote(session_label)}")
    parts.append("--interactive")
    inner = " ".join(parts)
    return f"zsh -lc {shlex.quote(inner)}"


def _session_has_claude(session):
    """Check if a tmux session has a running agent process (claude OR goose).

    Named for the common case but goose-aware: a goose-backed DeepSeek agent
    runs `goose`, not `claude`. Without the goose check, a stray wake/respawn
    would see "no claude here", treat the live goose agent as a dead pane, and
    kill-session it — the death-loop bug, reborn for goose."""
    try:
        r = subprocess.run(tmux("list-panes", "-t", session, "-F", "#{pane_pid}"),
                           capture_output=True, text=True, timeout=5)
        if r.returncode != 0:
            return False
        for pid in r.stdout.strip().split():
            ps = subprocess.run(["ps", "-p", pid, "-o", "args="],
                                capture_output=True, text=True, timeout=5)
            if ps.returncode == 0 and ("claude" in ps.stdout or "goose" in ps.stdout):
                return True
        return False
    except Exception:
        return False


def acquire_wake_lock(session):
    """Single-flight the wake path per tmux session.

    Wakes arrive from several sources (chat, keepalive, the user, other agents)
    and the daemon's dedupe clears when fleet-spawn exits (~15s) — before claude
    finishes booting. Two wakes can then both pass the 'is it alive?' check and
    both launch, and the loser's respawn-pane lands on the winner's booting
    claude. Holding an exclusive, non-blocking flock for the WHOLE respawn
    (check → launch → inject → boot) makes that impossible: a second wake that
    can't grab the lock bails immediately instead of clobbering.

    Returns the open file object (keep it alive to hold the lock; it releases
    when this process exits) or None if another wake already holds it."""
    lock_dir = os.path.join(tempfile.gettempdir(), "fleet-spawn-locks")
    try:
        os.makedirs(lock_dir, exist_ok=True)
    except Exception:
        return _SENTINEL_NO_LOCK  # can't make the dir → don't block the spawn
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", session)
    fd = open(os.path.join(lock_dir, f"{safe}.lock"), "w")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fd.close()
        return None  # another wake for this session is in flight
    return fd


# Returned when locking is unavailable (e.g. can't create the lock dir): a
# truthy non-lock so the caller proceeds rather than treating it as "held".
_SENTINEL_NO_LOCK = object()

def dismiss_devchannels(session, timeout=30):
    """Poll the pane and dismiss the dev-channels confirmation dialog (option 1)
    the moment it appears. Bounded by `timeout` so it can't loop forever — that
    was the original over-correction. Returns early once the ❯ prompt is up with
    no dialog, so a no-dialog start doesn't wait the full timeout.

    The fresh-spawn path previously fired a single blind keystroke at t=3s; when
    Claude Code was slow the dialog appeared later and the agent hung. This polls
    instead, the same way the resume path (inject_prompt) already does."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = subprocess.run(tmux("capture-pane", "-t", session, "-p"),
                               capture_output=True, text=True, timeout=5)
            if r.returncode == 0:
                pane = r.stdout
                if 'development-channels' in pane and 'Enter to confirm' in pane:
                    subprocess.run(tmux("send-keys", "-t", session, "1"), capture_output=True, timeout=5)
                    time.sleep(0.5)
                    subprocess.run(tmux("send-keys", "-t", session, "Enter"), capture_output=True, timeout=5)
                    return True
                # ❯ prompt up and no dialog pending — nothing to dismiss.
                if 'Enter to confirm' not in pane and any('❯' in l for l in pane.splitlines()[-3:]):
                    return False
        except Exception:
            pass
        time.sleep(0.5)
    return False


def spawn_tmux(session, cwd, cmd, auto_dismiss=True):
    """Start a tmux session running cmd. When auto_dismiss=True, backgrounds
    a process to dismiss the dev-channels confirmation dialog."""
    # Try respawn-pane first — handles dead panes left by remain-on-exit.
    # Falls back to new-session when no session exists.
    # TMUX is cleared in env so tmux doesn't print the "sessions should be
    # nested with care" warning when fleet-spawn is invoked from inside an
    # existing tmux session (e.g. an agent calling mcp__tlda__spawn).
    spawn_env = {**os.environ, "TMUX": ""}
    r = subprocess.run(tmux("respawn-pane", "-t", session, "-c", cwd, cmd),
                       capture_output=True, timeout=5, env=spawn_env)
    if r.returncode != 0:
        # respawn-pane (no -k) only succeeds on a pane whose command has EXITED.
        # It fails for two very different reasons:
        #   (a) the pane has a LIVE claude — respawn-pane refuses to replace a
        #       running process. Killing it here was the death-loop bug: a wake
        #       that lands on a running agent would murder it and restart. NEVER
        #       do that — a live claude means the agent is already up, which is
        #       success. Bail and leave it alone.
        #   (b) a dead pane (status 1, remain-on-exit) that tmux won't revive
        #       leaves the session present — so new-session would collide with
        #       "duplicate session" and the spawn never recovers (observed when
        #       re-spawning agent-ui). That stale session we DO clear.
        if _session_has_claude(session):
            return False  # already alive — do not restart, do not inject
        # Dead pane / stale session: kill it so the fallback starts fresh.
        # kill-session on a missing session is a no-op.
        subprocess.run(tmux("kill-session", "-t", session),
                       capture_output=True, timeout=5, env=spawn_env)
        subprocess.run(tmux("new-session", "-d", "-s", session, "-c", cwd, cmd),
                       check=True, env=spawn_env)
        subprocess.run(tmux("set-option", "-t", session, "remain-on-exit", "on"),
                       capture_output=True, timeout=5, env=spawn_env)
    if auto_dismiss:
        # Background the bounded poll-and-dismiss (see dismiss_devchannels).
        # Detached so spawn_tmux returns immediately and the dismiss survives
        # this process exiting.
        subprocess.Popen(
            [sys.executable, __file__, "--_dismiss-devch", session],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    return True  # (re)started in this session


def verify_session(session, context=""):
    """Check that the tmux session survived startup."""
    time.sleep(2)
    if subprocess.run(tmux("has-session", "-t", session), capture_output=True).returncode != 0:
        print(f"Error: Claude could not resume{' ' + context if context else ''}.", file=sys.stderr)
        sys.exit(1)


def inject_prompt(session, prompt, timeout=60):
    """Wait for Claude Code's ❯ prompt, then inject text via tmux send-keys.
    Handles startup dialogs: dev-channels confirmation and resume-from-summary."""
    deadline = time.time() + timeout
    dismissed_devch = False
    dismissed_summary = False
    while time.time() < deadline:
        try:
            r = subprocess.run(
                tmux("capture-pane", "-t", session, "-p"),
                capture_output=True, text=True, timeout=5)
            if r.returncode != 0:
                time.sleep(1)
                continue
            pane = r.stdout.rstrip()
            # Dev-channels dialog — select option 1
            if not dismissed_devch and 'development-channels' in pane and 'Enter to confirm' in pane:
                subprocess.run(tmux("send-keys", "-t", session, "1"), capture_output=True, timeout=5)
                time.sleep(0.5)
                subprocess.run(tmux("send-keys", "-t", session, "Enter"), capture_output=True, timeout=5)
                dismissed_devch = True
                time.sleep(3)
                continue
            # Resume-from-summary dialog — select option 2 (full resume)
            if not dismissed_summary and 'Resume from summary' in pane:
                subprocess.run(tmux("send-keys", "-t", session, "2"), capture_output=True, timeout=5)
                time.sleep(0.5)
                subprocess.run(tmux("send-keys", "-t", session, "Enter"), capture_output=True, timeout=5)
                dismissed_summary = True
                time.sleep(3)
                continue
            lines = pane.split('\n')
            # Claude Code renders a status bar (mode/effort) below the ❯ input
            # line, so ❯ is not on lines[-1] — scan the last few lines.
            prompt_ready = any('❯' in l for l in lines[-3:])
            if prompt_ready and 'Enter to confirm' not in pane:
                # Clear any stale text in the input box before typing.
                subprocess.run(tmux("send-keys", "-t", session, "C-u"), capture_output=True, timeout=5)
                time.sleep(0.2)
                subprocess.run(tmux("send-keys", "-t", session, prompt), capture_output=True, timeout=5)
                time.sleep(0.3)
                subprocess.run(tmux("send-keys", "-t", session, "Enter"), capture_output=True, timeout=5)
                return True
        except Exception:
            pass
        time.sleep(1)
    print(f"  Warning: timed out waiting for prompt in {session}", file=sys.stderr)
    return False


# ---- Spawn modes ----

def fresh(name, model, cwd, effort, mode):
    server_up = ensure_server()
    fleet_id = f"fleet:{uuid.uuid4().hex[:8]}"
    sess = unique_session_name(f"fleet-{sanitize_session_name(name)}")
    cwd = resolve_spawn_cwd(cwd)
    goose_model = resolve_goose_model(model)
    # Store the resolved model id in meta either way so a later respawn knows
    # which engine to use (resolve_goose_model recognizes the deepseek-v4-* id).
    model = goose_model or resolve_model(model)

    if server_up:
        existing = find_agent(name)
        if existing:
            print(f"Error: '{name}' already exists ({existing['id']}). "
                  f"Use: fleet-spawn {name}", file=sys.stderr)
            sys.exit(1)
        collisions = check_name_collisions(name)
        if collisions:
            lines = [f"Error: '{name}' is not available:"]
            kinds = {}
            for c in collisions:
                kinds.setdefault(c.get("kind"), []).append(c.get("agent_id"))
            if "pseudo_label" in kinds:
                lines.append(f"  • reserved routing label (awake / hibernating / human / human-away)")
            if "friendly_name" in kinds:
                lines.append(f"  • already the friendly_name of {kinds['friendly_name'][0]}")
            if "label" in kinds:
                ids = kinds["label"]
                shown = ", ".join(ids[:5])
                more = f" (+{len(ids) - 5} more)" if len(ids) > 5 else ""
                lines.append(f"  • collides with a label on {len(ids)} live agent(s): {shown}{more}")
            lines.append("")
            lines.append("  Pick a different name, or drop the conflicting label first.")
            print("\n".join(lines), file=sys.stderr)
            sys.exit(1)
        ws_register(fleet_id, name, sess, cwd, model, effort, refresh=True)

    if goose_model:
        cmd = build_goose_cmd(fleet_id, sess, goose_model, name=name)
    else:
        cmd = build_claude_cmd(fleet_id, sess, model, effort, mode, name=name)
    spawn_tmux(sess, cwd, cmd)
    print(f"{sess} ({fleet_id}) spawned in {cwd}")
    return sess


def respawn(name, model, cwd, effort, mode, session_override=None):
    ensure_server()
    agent = find_agent(name)
    if not agent:
        print(f"Error: No agent '{name}'. Use --fresh to create.", file=sys.stderr)
        sys.exit(1)

    fleet_id = agent["id"]
    meta = agent_meta(agent)
    cwd = cwd or agent.get("cwd") or os.getcwd()
    raw_model = model or meta.get("model")
    goose_model = resolve_goose_model(raw_model)
    model = goose_model or resolve_model(raw_model)
    sess = agent.get("tmux_session") or f"fleet-{name}"

    # Single-flight: hold a per-session lock across the WHOLE wake (check →
    # launch → inject → boot). A concurrent wake that can't grab it bails
    # instead of clobbering the booting claude. _lock must stay referenced for
    # the lifetime of this process so the flock is held until we exit.
    _lock = acquire_wake_lock(sess)
    if _lock is None:
        print(f"  another wake for {name} is already in flight — bailing", file=sys.stderr)
        return sess

    if subprocess.run(tmux("has-session", "-t", sess), capture_output=True).returncode == 0:
        if _session_has_claude(sess):
            return sess

    if goose_model:
        # Goose agents are stateless-role-from-chat: there is no resumable claude
        # transcript, so "respawn" is a fresh goose launch with the SAME fleet_id
        # — the recipe re-briefs the agent via my_task. spawn_tmux's alive-check
        # is goose-aware, so a live goose agent is left running, not clobbered.
        cmd = build_goose_cmd(fleet_id, sess, goose_model, name=name)
        started = spawn_tmux(sess, cwd, cmd, auto_dismiss=False)
        if not started:
            print(f"{sess} ({fleet_id}) already alive — left running", file=sys.stderr)
        else:
            print(f"{sess} ({fleet_id}) relaunched (goose)")
        return sess

    result = None
    if session_override:
        resume_id = session_override
    else:
        result = find_valid_session(agent)
        if not result:
            print(f"Error: No valid session to resume for {name} ({fleet_id}). Use --refresh to start fresh.", file=sys.stderr)
            sys.exit(1)
        resume_id, jsonl_cwd = result
        if jsonl_cwd:
            cwd = jsonl_cwd

    # NEVER fall back to --refresh here. --refresh spawns an imposter agent
    # with no real context. If --resume is stuck in a death loop, let it fail
    # visibly so someone can diagnose — don't silently replace the agent.

    strip_synthetic_tail(resume_id)

    cmd = build_claude_cmd(fleet_id, sess, model, effort, mode,
                           resume_id=resume_id, include_prompt=False, name=name)
    started = spawn_tmux(sess, cwd, cmd, auto_dismiss=False)
    if not started:
        # spawn_tmux found a live claude (a wake raced past the check above) and
        # left it running. Don't verify/inject into the already-running agent.
        print(f"{sess} ({fleet_id}) already alive — left running", file=sys.stderr)
        return sess
    verify_session(sess, f"session {resume_id}")
    inject_prompt(sess, register_prompt(name))
    print(f"{sess} ({fleet_id}) resumed {resume_id}")
    return sess


def refresh(name, model, cwd, effort, mode):
    ensure_server()
    agent = find_agent(name)
    if not agent:
        print(f"Error: No agent '{name}'. Use --fresh to create.", file=sys.stderr)
        sys.exit(1)

    fleet_id = agent["id"]
    meta = agent_meta(agent)
    cwd = cwd or agent.get("cwd") or os.getcwd()
    raw_model = model or meta.get("model")
    goose_model = resolve_goose_model(raw_model)
    model = goose_model or resolve_model(raw_model)
    if not effort:
        effort = meta.get("effort")
    sess = agent.get("tmux_session") or f"fleet-{name}"

    ws_register(fleet_id, name, sess, cwd, model, effort, refresh=True)
    if goose_model:
        cmd = build_goose_cmd(fleet_id, sess, goose_model, name=name)
    else:
        cmd = build_claude_cmd(fleet_id, sess, model, effort, mode, name=name)
    spawn_tmux(sess, cwd, cmd)
    print(f"{sess} ({fleet_id}) refreshed in {cwd}")
    return sess


def respawn_session(session_uuid, name_override, model, cwd, effort, mode,
                    enroll=False, dry_run=False):
    """Respawn by session UUID — scans JSONL for fleet identity."""
    import glob as globmod
    import re

    matches = globmod.glob(os.path.join(
        os.path.expanduser("~/.claude/projects"), "*", f"{session_uuid}.jsonl"))
    if not matches:
        print(f"Error: No JSONL for session {session_uuid}", file=sys.stderr)
        sys.exit(1)

    fpath = matches[0]
    fleet_id = None
    agent_name = None
    reg_re = re.compile(r'Registered (fleet:\w+)')
    name_re = re.compile(r'Your name: "([^"]+)"')

    try:
        with open(fpath, "r", errors="replace") as f:
            for line in f:
                if "Registered fleet:" not in line:
                    continue
                try:
                    d = json.loads(line.strip())
                    tur = d.get("toolUseResult")
                    if not tur:
                        continue
                    for item in (tur if isinstance(tur, list) else [tur]):
                        text = item.get("text", "") if isinstance(item, dict) else str(item)
                        m = reg_re.search(text)
                        if m:
                            fleet_id = m.group(1)
                            nm = name_re.search(text)
                            if nm:
                                agent_name = nm.group(1)
                            break
                    if fleet_id:
                        break
                except (json.JSONDecodeError, AttributeError):
                    continue
    except OSError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    if enroll and fleet_id:
        print(f"Error: Session already has {fleet_id}. Drop --enroll.", file=sys.stderr)
        sys.exit(1)
    if not fleet_id and not enroll:
        print(f"Error: No fleet ID in session {session_uuid}", file=sys.stderr)
        sys.exit(1)

    if not cwd:
        project_dir = os.path.basename(os.path.dirname(fpath))
        cwd = ("/" + project_dir[1:].replace("-", "/")) if project_dir.startswith("-") else os.getcwd()

    if enroll and not fleet_id:
        ensure_server()
        fleet_id = f"fleet:{uuid.uuid4().hex[:8]}"
        agent_name = name_override or os.path.basename(cwd.rstrip("/")) or "agent"
        try:
            agents = api_get("/api/store/agents")
            taken = {a.get("friendly_name") for a in agents}
            base = agent_name
            n = 2
            while agent_name in taken:
                agent_name = f"{base}-{n}"
                n += 1
        except Exception:
            pass

    agent_name = name_override or agent_name or fleet_id.replace("fleet:", "agent-")
    model = resolve_model(model)
    sess = f"fleet-{sanitize_session_name(agent_name)}"

    if dry_run:
        print(f"[dry-run] {sess} ({fleet_id}) — session {session_uuid}, cwd {cwd}")
        return sess

    ensure_server()
    ws_register(fleet_id, agent_name, sess, cwd, model, effort)
    cmd = build_claude_cmd(fleet_id, sess, model, effort, mode, resume_id=session_uuid, name=agent_name)
    spawn_tmux(sess, cwd, cmd)
    verify_session(sess, f"session {session_uuid}")
    action = "enrolled" if enroll else "resumed"
    print(f"{sess} ({fleet_id}) {action} {session_uuid} in {cwd}")
    return sess


# ---- CLI ----

def main():
    parser = argparse.ArgumentParser(description="Spawn or respawn fleet agents")
    parser.add_argument("name", nargs="?")
    parser.add_argument("--fresh", action="store_true")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--model", default=None)
    parser.add_argument("--cwd", default=None)
    parser.add_argument("--effort", default=None)
    parser.add_argument("--mode", default=None)
    parser.add_argument("--session", default=None)
    parser.add_argument("--enroll", action="store_true")
    parser.add_argument("--no-attach", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--_dismiss-devch", default=None, help=argparse.SUPPRESS)
    args = parser.parse_args()

    # Internal: backgrounded dev-channels dialog dismisser (spawned by spawn_tmux).
    if args._dismiss_devch:
        dismiss_devchannels(args._dismiss_devch)
        return

    if not args.name and not args.session:
        parser.print_usage(sys.stderr)
        print("Error: provide a name or --session <uuid>", file=sys.stderr)
        sys.exit(2)
    if args.enroll and not args.session:
        print("Error: --enroll requires --session <uuid>", file=sys.stderr)
        sys.exit(2)

    mode = args.mode or read_config().get("spawnMode")

    try:
        args.effort = resolve_effort(args.effort)
        if args.session and (not args.name or args.enroll):
            sess = respawn_session(args.session, args.name, args.model, args.cwd,
                                   args.effort, mode, args.enroll, args.dry_run)
        elif args.fresh:
            sess = fresh(args.name, args.model, args.cwd, args.effort, mode)
        elif args.refresh:
            sess = refresh(args.name, args.model, args.cwd, args.effort, mode)
        else:
            sess = respawn(args.name, args.model, args.cwd, args.effort, mode, args.session)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(2)

    if not args.no_attach and not args.dry_run:
        cmd = tmux("attach-session", "-t", sess)
        os.execvp(cmd[0], cmd)


if __name__ == "__main__":
    main()
