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
import copy
import ipaddress
import json
import fcntl
import os
import re
import shlex
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.request import urlopen, Request
from urllib.error import URLError
from urllib.parse import urlparse
import websocket

CONFIG_FILE = os.path.join(os.path.expanduser("~"), ".config", "tlda", "config.json")
CODEX_CONFIG_FILE = os.path.join(os.path.expanduser("~"), ".codex", "config.toml")
DEFAULT_SPAWN_CAPABILITY = "write"


def normalize_spawn_capability(capability, region=None):
    """Map any capability (old machine vocabulary or the four names) to one of
    Skip's four rungs: read / write / tlda-write / full. The region disambiguates
    the legacy write/tlda-write split (both were `workspace-write`). Mirrors
    legacyRung() in server/lib/spawn-policy.mjs. The daemon and CLI now emit the
    four names; this is migration tolerance for any stale old-vocabulary value.
    `workspace-write-no-net` -> write (net is always on now)."""
    if capability is None:
        return None
    raw = str(capability).strip().lower()
    if raw in ("read", "write", "tlda-write", "full"):
        return raw
    if raw == "read-only":
        return "read"
    if raw == "full-access":
        return "full"
    if raw in ("workspace-write", "workspace-write+net", "workspace-write-no-net"):
        reg = None if region is None else str(region).strip().lower()
        return "tlda-write" if reg == "tlda-projects" else "write"
    return raw


def read_config():
    try:
        with open(CONFIG_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _http_form(url):
    return re.sub(r"/+$", "", url.replace("wss:", "https:", 1).replace("ws:", "http:", 1))


def resolve_api():
    if os.environ.get("TLDA_SERVER"):
        return _http_form(os.environ["TLDA_SERVER"])
    cfg = read_config()
    name = os.environ.get("TLDA_CONFIG") or cfg.get("defaultConfig")
    raw = (cfg.get("configs") or {}).get(name or "")
    if isinstance(raw, dict):
        endpoint = raw.get("database") or raw.get("store")
        if isinstance(endpoint, str) and endpoint:
            return _http_form(endpoint)
    if cfg.get("fleetServer"):
        return _http_form(cfg["fleetServer"])
    if cfg.get("server"):
        return _http_form(cfg["server"])
    dash_port = os.environ.get("FLEET_DASH_PORT", "5176")
    dash_host = os.environ.get("FLEET_DASH_HOST", "127.0.0.1")
    tls_cert = os.path.expanduser("~/.config/tlda/localhost+2.pem")
    scheme = "https" if os.path.exists(tls_cert) else "http"
    return f"{scheme}://{dash_host}:{dash_port}"


API = resolve_api()
_tls_cert = os.path.expanduser("~/.config/tlda/localhost+2.pem")
_scheme = "https" if API.startswith("https://") else "http"
_ca_path = os.path.expanduser("~/Library/Application Support/mkcert/rootCA.pem")
_ssl_ctx = None
if API.startswith("https://127.0.0.1") and os.path.exists(_ca_path):
    _ssl_ctx = ssl.create_default_context()
    _ssl_ctx.load_verify_locations(_ca_path)


def _is_local_api():
    return bool(re.match(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$", API))


def _ws_api():
    return API.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
DEFAULT_MODEL = "claude-opus-4-8[1m]"
REGISTER_PROMPT = "Call register() with the fleet MCP server. Then call my_task() to check for a pending task."
NON_CLAUDE_GUIDANCE_CONTRACT = (
    "Non-Claude guidance contract: respond in the visible channel before acting when the user is waiting; "
    "browser-visible or user-visible reports are ground truth; do not claim fixed or done without checking "
    "the right surface; do not ask the user to verify routine fixes you can verify; if corrected, stop and "
    "change course before continuing; proof obligations are requirements, not optional suggestions."
)
CODEX_GUIDANCE_PROMPT = (
    "Then, before task work, read the same project guidance Claude agents receive here: "
    "read CLAUDE.md in the workspace if it exists, and read AGENTS.md if it exists. "
    "Follow the guidance you find. If a tlda MCP tool blocks on required skill(s), "
    "read each named skill with skill(\"<name>\") or dismiss it with a specific reason, "
    "then retry the blocked tool. "
    + NON_CLAUDE_GUIDANCE_CONTRACT
)


def register_prompt(name=None, harness=None):
    """The register prompt, with the friendly name baked in so the agent
    registers under the name it was spawned with. Without this the agent has
    no clean source for its name and derives it from the tmux window
    (FLEET_TMUX_SESSION), which carries slot suffixes like ``-1b`` — that's how
    the friendly name gets corrupted to ``leverage?-1b``."""
    if name:
        prompt = f'Call register(name="{name}") with the fleet MCP server. Then call my_task() to check for a pending task.'
    else:
        prompt = REGISTER_PROMPT
    if harness == "codex":
        prompt = f"{prompt} {CODEX_GUIDANCE_PROMPT}"
    return prompt


def codex_register_prompt(name=None):
    return register_prompt(name, harness="codex")

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
# Friendly alias → concrete OpenRouter `vendor/model` id. These are the curated
# names; any raw `vendor/model` id also works (see resolve_goose_model), so this
# table is convenience, not a whitelist. Add a family's newest tool-capable
# snapshot here once it PASSES the probe (bin/verify-goose-toolcalls.mjs).
GOOSE_MODELS = {
    # Bare `deepseek` → the current flagship (v4-pro). Verified 2026-06-13 to
    # emit structured tool-calls through goose/OpenRouter and read/reason over a
    # doc end-to-end — Skip's pick for the default goose/adversary model. The
    # cheaper deepseek-chat is still selectable by its explicit alias.
    "deepseek": "deepseek/deepseek-v4-pro",
    "deepseek-chat": "deepseek/deepseek-chat",
    "deepseek-v3": "deepseek/deepseek-v3.2",
    "deepseek-r1": "deepseek/deepseek-r1-0528",
    "deepseek-reasoner": "deepseek/deepseek-r1-0528",
    "deepseek-v4": "deepseek/deepseek-v4-pro",
    "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
    "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
    # Other families — aliases registered; each is confirmed/denied by the probe
    # and the verified set below. An UNVERIFIED alias still resolves (warn only),
    # so you can probe it; it just isn't trusted for tool-using roles yet.
    # Each family: a bare alias (the default version we use) AND an explicit
    # version alias, so both resolve and both show in completions — mirroring
    # opus/opus48 and deepseek/deepseek-v4-pro.
    "kimi": "moonshotai/kimi-k2.7-code",
    "kimi-k2.7": "moonshotai/kimi-k2.7-code",
    "qwen": "qwen/qwen3.7-max",
    "qwen3.7-max": "qwen/qwen3.7-max",
    "glm": "z-ai/glm-5.1",
    "glm-5.1": "z-ai/glm-5.1",
    "minimax": "minimax/minimax-m3",
    "minimax-m3": "minimax/minimax-m3",
    "gemini": "google/gemini-3.5-flash",
    "gemini-3.5-flash": "google/gemini-3.5-flash",
    "mistral": "mistralai/mistral-medium-3-5",
    "mistral-medium-3-5": "mistralai/mistral-medium-3-5",
}

# OpenRouter ids VERIFIED to emit STRUCTURED tool-calls through goose
# (bin/verify-goose-toolcalls.mjs). Advertising OpenRouter "tools" support is
# necessary but NOT sufficient — some models narrate tool-calls as text
# (deepseek-r1 did), which leaves the agent unable to act. Only ids here are
# known-good for tool-using fleet agents; resolving to anything else warns.
GOOSE_VERIFIED = {
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-chat",
    "deepseek/deepseek-v3.2",
    "deepseek/deepseek-r1-0528",
    # Probed 2026-06-13 via bin/verify-goose-toolcalls.mjs — all emitted
    # structured tool-calls (register+my_task) through goose, zero text-format.
    # (google/gemini-3.5-flash was INCONCLUSIVE — no tool-calls in the window;
    #  left off until it's re-probed and confirmed.)
    "moonshotai/kimi-k2.7-code",
    "qwen/qwen3.7-max",
    "z-ai/glm-5.1",
    "minimax/minimax-m3",
    "mistralai/mistral-medium-3-5",
}
GOOSE_BIN = "/opt/homebrew/bin/goose"
DEEPSEEK_RECIPE = os.path.join(
    os.path.dirname(os.path.realpath(__file__)), "..", "recipes", "fleet-deepseek.yaml")
GOOSE_STATE_ROOT = "/tmp/tlda-goose-state"

CODEX_MODELS = {
    # `codex -m gpt` is not accepted for ChatGPT-authenticated Codex accounts.
    # Keep the short UI alias, but resolve it to the supported subscription
    # model id so `doc:name:gpt` and `doc:gpt` spawn a usable Codex agent.
    "gpt": "gpt-5.5",
    "codex": "gpt-5.5",
    "gpt-5.5": "gpt-5.5",
}


def resolve_goose_model(model):
    """Return the concrete OpenRouter model id if `model` selects a goose-backed
    agent, else None (meaning: a normal Claude agent).

    Accepts a curated alias (GOOSE_MODELS) or any raw `vendor/model` OpenRouter
    id. The discriminator is the `/`: Claude model specs (`opus`, `sonnet`,
    `claude-opus-4-7`, …) never contain one, while every OpenRouter id does. So a
    respawn whose stored meta.model is an already-resolved id still routes to
    goose, and any new OpenRouter model works without a code change."""
    if not model:
        return None
    if model in GOOSE_MODELS:
        return GOOSE_MODELS[model]
    if "/" in model:   # any OpenRouter vendor/model id → goose
        return model
    return None


def goose_model_verified(resolved_id):
    """True if this concrete OpenRouter id is on the verified-tool-calling list."""
    return resolved_id in GOOSE_VERIFIED

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)
TLDA_CLI = os.path.join(REPO_DIR, "cli", "tlda.mjs")
NODE_DNS_ALIAS_PRELOAD = os.path.join(REPO_DIR, "shared", "node-dns-alias.cjs")


def _deep_merge(base, overlay):
    if not isinstance(base, dict) or not isinstance(overlay, dict):
        return copy.deepcopy(overlay)
    out = copy.deepcopy(base)
    for key, val in overlay.items():
        if isinstance(val, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], val)
        else:
            out[key] = copy.deepcopy(val)
    return out


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
    if not _is_local_api():
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


def ws_register(fleet_id, name, tmux_session, cwd, model=None, effort=None, refresh=False,
                kind="claude", spawn_capability=None, session_id=None,
                metadata=None):
    ws_url = f"{_ws_api()}/ws/fleet?agent={fleet_id}"
    try:
        ws_opts = {"timeout": 5}
        if _ssl_ctx:
            ws_opts["sslopt"] = {"context": _ssl_ctx}
        ws = websocket.create_connection(ws_url, **ws_opts)
        machine_id = read_config().get("machineId")
        msg = {"type": "register", "id": fleet_id, "name": name,
               "tmux_session": tmux_session, "cwd": cwd, "kind": kind}
        if machine_id:
            msg["machine_id"] = machine_id
        if session_id:
            msg["session_id"] = session_id
        meta = dict(metadata or {})
        if model:
            meta["model"] = model
        if effort:
            meta["effort"] = effort
        if refresh:
            meta["refresh"] = True
        if spawn_capability:
            spawn_policy = dict(meta.get("spawnPolicy") or {})
            spawn_policy["capability"] = spawn_capability
            meta["spawnPolicy"] = spawn_policy
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
            # The session's OWN identity is its FIRST "Registered fleet:…"
            # result: a fleet agent registers itself at session start, before
            # it can spawn or read_terminal any other agent. Later
            # registrations in the same transcript belong to agents this one
            # spawned/inspected (e.g. logaudit spawning codexwake) — matching
            # the LAST one mis-attributes the session and skips it on resume.
            own_registered_id = None
            try:
                with open(fpath, "r", errors="replace") as f:
                    for line in f:
                        if own_registered_id:
                            break
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
                                    own_registered_id = m.group(1)
                                    break
                        except (json.JSONDecodeError, AttributeError):
                            continue
            except OSError:
                continue
            if own_registered_id == fleet_id:
                candidates.append((sid, mtime, fpath))
    if candidates:
        candidates.sort(key=lambda x: x[1], reverse=True)
        best_sid, _, best_path = candidates[0]
        print(f"  found {len(candidates)} session(s) via content scan, using {best_sid}", file=sys.stderr)
        return (best_sid, _jsonl_path_to_cwd(best_path))

    return None


# ---- Codex rollout resume ----
#
# Codex agents don't have a resumable Claude JSONL; they store interactive
# rollouts at ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl, and
# `codex resume <uuid>` continues one with full context. fleet-spawn never knows
# the rollout uuid ahead of time (codex mints it at launch), so — exactly like
# Claude's step-3 content scan — we recover it by scanning rollouts for the
# agent's OWN fleet id.


def _codex_rollout_path(rollout_id):
    """Return the on-disk path of a codex rollout by its uuid, or None."""
    import glob as _glob

    sessions_base = os.path.expanduser("~/.codex/sessions")
    if not rollout_id or not os.path.isdir(sessions_base):
        return None
    hits = _glob.glob(
        os.path.join(sessions_base, "**", f"rollout-*-{rollout_id}.jsonl"),
        recursive=True,
    )
    return hits[0] if hits else None


def _scan_codex_rollout_identity(fpath):
    """Read a codex rollout's OWN fleet identity + session_meta.

    Returns (own_fleet_id, agent_name, session_meta_dict). Mirrors
    find_valid_session: the agent's own id is the FIRST 'Registered fleet:…' in
    the rollout — later registrations belong to agents this one spawned/inspected
    (the spawned-others mis-attribution bug). Codex rollout records use a
    different schema than Claude JSONL, so we match the register text on the raw
    line rather than via a fixed toolUseResult shape."""
    import re as _re

    reg_re = _re.compile(r"Registered (fleet:\w+)")
    name_re = _re.compile(r'Your name: "([^"]+)"')
    own_id = None
    agent_name = None
    meta = None
    try:
        with open(fpath, "r", errors="replace") as f:
            for line in f:
                if meta is None and '"session_meta"' in line:
                    try:
                        meta = json.loads(line).get("payload") or {}
                    except json.JSONDecodeError:
                        meta = {}
                if own_id is None and "Registered fleet:" in line:
                    m = reg_re.search(line)
                    if m:
                        own_id = m.group(1)
                        nm = name_re.search(line)
                        if nm:
                            agent_name = nm.group(1)
                if own_id is not None and meta is not None:
                    break
    except OSError:
        pass
    return own_id, agent_name, (meta or {})


def find_codex_rollout(agent):
    """Find the agent's latest codex rollout → resume handle, or None.

    Mirrors find_valid_session: match by the agent's OWN fleet id, newest mtime
    wins. cwd is recorded on the handle (for cwd recovery on resume), not used as
    a selector — recency is the tiebreak. The handle is the shape the daemon /
    harness adapter consume: { kind, rolloutId, jsonlPath, cwd, sessionMeta }."""
    import glob as _glob
    import re as _re

    sessions_base = os.path.expanduser("~/.codex/sessions")
    fleet_id = agent.get("id")
    if not fleet_id or not os.path.isdir(sessions_base):
        return None
    print(f"  scanning codex rollouts for {fleet_id}...", file=sys.stderr)
    uuid_re = _re.compile(
        r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    )
    candidates = []
    for fpath in _glob.glob(
        os.path.join(sessions_base, "**", "rollout-*.jsonl"), recursive=True
    ):
        try:
            mtime = os.path.getmtime(fpath)
        except OSError:
            continue
        own_id, _name, meta = _scan_codex_rollout_identity(fpath)
        if own_id != fleet_id:
            continue
        rollout_id = meta.get("id")
        if not rollout_id:
            m = uuid_re.search(os.path.basename(fpath))
            rollout_id = m.group(1) if m else None
        if not rollout_id:
            continue
        candidates.append((mtime, rollout_id, fpath, meta))
    if not candidates:
        return None
    candidates.sort(key=lambda x: x[0], reverse=True)
    _mtime, rollout_id, fpath, meta = candidates[0]
    print(
        f"  found {len(candidates)} codex rollout(s), using {rollout_id}",
        file=sys.stderr,
    )
    return {
        "kind": "codex",
        "rolloutId": rollout_id,
        "jsonlPath": fpath,
        "cwd": meta.get("cwd"),
        "sessionMeta": meta,
    }


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


# ---- Sandbox / native developer policy ----

SANDBOX_CONFIG_KEY = "agentSandbox"
SANDBOX_POLICIES = {"no-dev", "cwd", "tlda-projects", "unsandboxed"}
DEFAULT_SANDBOX_POLICY = "cwd"
DEFAULT_SANDBOX_READ_ROOTS = ["~/work"]
DEFAULT_SANDBOX_OPTIONS = {
    "network": False,
    "git": "read",
    "artifacts": True,
}
DEFAULT_TRUSTED_MCP_SERVERS = {
    "tlda": {
        "defaultToolsApprovalMode": "approve",
    },
}
PLAYWRIGHT_CACHE_ROOT = os.path.expanduser("~/Library/Caches/ms-playwright")
TLDA_FENCE_TMP_ROOT = "/tmp/tlda-fence-env"
# The shared playwright-cli daemon's client<->daemon UNIX socket. cli/lib/pw.mjs
# pins PLAYWRIGHT_DAEMON_SOCKETS_DIR here so it lands under /tmp (shared 1:1 with
# the fence) instead of $TMPDIR (which the fence remaps). A fenced app agent drives
# the OUT-of-fence browser by connecting to this socket, so the lease must whitelist
# AF_UNIX connect to it (macOS denies unix-socket connect by default even with
# allowLocalOutbound, which only covers TCP loopback). Without this a fenced
# `tlda-dev pw` reads the live session as "closed" and kills the real browser.
TLDA_PW_SOCKETS_ROOT = "/tmp/tlda-pw-sockets"
# Global fence switch (Skip 2026-06-19). When True, every LIVE spawn is forced
# unsandboxed (applied at the launch sites via _live_spawn_policy, NOT the pure
# resolver, so leases + the run-through gate still compute real fenced configs).
# It is now ON (False): fresh spawns are fenced by default. An EXPLICIT --policy
# still overrides this either way, so the fence stays per-agent testable. The
# fence was made genuinely usable first (keychain auth, browser drive over the
# pw daemon socket, fleet WS via the DNS alias, no-prompt via
# --dangerously-skip-permissions, memory writes, cold-browser guard), so turning
# it on no longer breaks an agent's job -- it just removes the unsandboxed
# default. Flip back to True only to globally disable the fence.
FENCE_GLOBALLY_DISABLED = True
# Permission mode per sandbox policy. THE POINT OF THE FENCE (Skip 2026-06-19):
# a fenced agent does normal work with ZERO Claude permission prompts -- the
# fence is the security boundary, so Claude's interactive approvals are redundant
# torture ("I am being tortured by Claude's permissions... I want security against
# them doing things that are truly awful. That was the point of the fence").
# So every policy runs bypassPermissions: no prompts. The guardrail against
# "wildly inappropriate" actions is the fence itself (write-root scoping, secret
# read-deny, command-deny for push/sudo/publish, network allowlist) for fenced
# policies, and the family/trust ceiling for unsandboxed (only trusted families
# get full-access). "auto" still prompted for out-of-workspace writes (memory!),
# which is exactly the approval torture this removes.
DEFAULT_CLAUDE_PERMISSION_MODES = {
    "cwd": "bypassPermissions",
    "tlda-projects": "bypassPermissions",
    # NOTE: no "unsandboxed" entry. bypassPermissions is safe ONLY because the
    # fence is the guardrail; an UNSANDBOXED agent with no prompts has no
    # guardrail at all, so unsandboxed keeps its prior behavior (Claude default).
    # The cwd/tlda-projects entries only take effect when the fence is ON.
}
FENCE_AGENT_WRITE_ROOTS = [
    "/tmp",
    "~/.cache/**",
    "~/.codex/**",
    "~/.claude*",
    "~/.claude/**",
    # Auto-memory: ~/.claude/projects/<proj>/memory is a SYMLINK to
    # ~/work/dot-claude-memory/<proj>, and the fence resolves the symlink and
    # checks the TARGET. Without the target as a write root, every agent memory
    # write is denied ("operation not permitted") — which is the exact opposite
    # of Skip's goal (agents write memory freely, no prompts). Allow the real
    # store. (Memory is per-fleet-id scoped; writing junk to it isn't "truly
    # awful", so this is fine for fenced/untrusted agents too.)
    "~/work/dot-claude-memory",
    "~/work/dot-claude-memory/**",
    "~/.opencode/**",
    "~/.cursor/**",
    "~/.local/state/**",
    "~/.local/share/**",
    "~/.npm/_cacache",
    "~/.npm/_npx",
    "~/.zcompdump*",
]
FENCE_AGENT_READ_ROOTS = [
    "/tmp",
    "~/.codex",
    "~/.claude",
    "~/.claude.json",
    "~/.config/tlda",
    "~/.config/fence",
    "~/Library/Application Support/mkcert",
    "~/Library/Preferences",
    # Claude's OAuth token is NOT in ~/.claude.json -- on macOS it lives in the
    # login Keychain item "Claude Code-credentials" and is read via
    # `security find-generic-password`. A read-denied keychain-db => the agent
    # boots "Not logged in - Run /login". Keep this explicit so the keychain
    # stays readable even if defaultDenyRead is ever re-tightened. (Proven
    # 2026-06-19: fence without this => keychain read fails => Claude unauth'd.)
    "~/Library/Keychains",
]
FENCE_DENY_READ = [
    # Deny ALL of ~/.ssh, not just id_*/config: a private key with a non-standard
    # name (e.g. ~/.ssh/mykey) would otherwise slip through (reads are permissive).
    # Skip 2026-06-19: "deny all ~/.ssh/* except known_hosts -- that'd be smart."
    # The fence's denyRead beats allowRead, so known_hosts can't be carved back
    # out; it gets swept in too. That's fine -- known_hosts isn't a secret and
    # fenced agents use https for git (github.com is allow-listed), so nothing a
    # fenced agent legitimately does needs to read it.
    "~/.ssh/*",
    "~/.ssh/**",
    "~/.ssh/id_*",
    "~/.ssh/config",
    "~/.ssh/*.pem",
    "~/.gnupg/**",
    "~/.aws/**",
    "~/.config/gcloud/**",
    "~/.kube/**",
    "~/.docker/**",
    "~/.pypirc",
    "~/.netrc",
    "~/.git-credentials",
    "~/.cargo/credentials",
    "~/.cargo/credentials.toml",
]
FENCE_DENY_WRITE = [
    "**/.env",
    "**/.env.*",
    "**/*.key",
    "**/*.pem",
    "**/*.p12",
    "**/*.pfx",
]
FENCE_GIT_READONLY_DENY = [
    "**/.git/**",
    "**/.git",
    "**/.git/worktrees/**",
]
FENCE_COMMAND_DENY = [
    "git push",
    "git reset",
    "git clean",
    "git checkout --",
    "git rebase",
    "git merge",
    "npm publish",
    "pnpm publish",
    "yarn publish",
    "cargo publish",
    "twine upload",
    "gem push",
    "sudo",
]
FENCE_CODE_ALLOWED_DOMAINS = [
    "api.openai.com",
    # Codex CLI with ChatGPT auth talks to chatgpt.com/backend-api (model
    # responses + the codex_apps MCP), NOT api.openai.com. Without this a
    # sandboxed codex agent boots but every model call 403s at the fence proxy
    # ("Proxy connection failed: HTTP CONNECT 403"), so it never reasons, never
    # registers. This is the model-API allowlist (always allowed, like
    # *.anthropic.com for Claude) — distinct from policy.network, which only
    # gates LOCAL binding/outbound. So no-net codex now reaches its model.
    "chatgpt.com",
    "*.chatgpt.com",
    "*.anthropic.com",
    "api.githubcopilot.com",
    "generativelanguage.googleapis.com",
    "api.mistral.ai",
    "api.cohere.ai",
    "api.together.xyz",
    "openrouter.ai",
    "api.morphllm.com",
    "*.amazonaws.com",
    "opencode.ai",
    "api.opencode.ai",
    "ampcode.com",
    "*.ampcode.com",
    "*.factory.ai",
    "api.workos.com",
    "*.cursor.sh",
    "data.charm.land",
    "catwalk.charm.sh",
    "*.githubcopilot.com",
    "github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "gitlab.com",
    "registry.npmjs.org",
    "*.npmjs.org",
    "registry.yarnpkg.com",
    "pypi.org",
    "files.pythonhosted.org",
    "crates.io",
    "static.crates.io",
    "index.crates.io",
    "proxy.golang.org",
    "sum.golang.org",
    "formulae.brew.sh",
    "models.dev",
]


def _as_bool(val):
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.lower() in ("1", "true", "yes", "on", "allow", "allowed")
    return bool(val)


def _match_default(patterns, value):
    if not value or not isinstance(patterns, dict):
        return None
    for pattern, profile in patterns.items():
        if fnmatch.fnmatch(value, pattern):
            return profile
    return None


def _validate_sandbox_policy(policy):
    if policy not in SANDBOX_POLICIES:
        allowed = ", ".join(sorted(SANDBOX_POLICIES))
        raise ValueError(f'agentSandbox policy "{policy}" is not valid; expected one of: {allowed}')
    return policy


def _sandbox_config(required=False):
    full_cfg = read_config()
    cfg = full_cfg.get(SANDBOX_CONFIG_KEY)
    if not isinstance(cfg, dict):
        if SANDBOX_CONFIG_KEY in full_cfg:
            raise ValueError("agentSandbox must be an object")
        cfg = {}
    runner = cfg.get("runner") if isinstance(cfg.get("runner"), dict) else None
    if required and not runner and not shutil.which("fence"):
        raise ValueError(
            "Developer tools require agentSandbox.runner or an installed fence binary. "
            "Refusing to launch native file/shell tools without an outer sandbox."
        )
    return cfg


def _runner_from_config(cfg, required=True):
    runner = cfg.get("runner")
    if isinstance(runner, dict):
        if not isinstance(runner.get("command"), str) or not runner["command"]:
            raise ValueError("agentSandbox.runner.command is required")
        args = runner.get("args", [])
        if not isinstance(args, list):
            raise ValueError("agentSandbox.runner.args must be an array")
        return runner
    if shutil.which("fence"):
        return {"command": "fence"}
    if required:
        raise ValueError("agentSandbox.runner must be an object with command/args")
    return None


def _config_path_list(cfg, key, default=None):
    val = cfg.get(key, default or [])
    if isinstance(val, str):
        val = [val]
    if not isinstance(val, list):
        raise ValueError(f"agentSandbox.{key} must be a string or array")
    return [os.path.abspath(os.path.expanduser(p)) for p in val if isinstance(p, str) and p]


def _trusted_mcp_servers(cfg=None):
    cfg = cfg if isinstance(cfg, dict) else _sandbox_config(required=False)
    val = cfg.get("trustedMcpServers", DEFAULT_TRUSTED_MCP_SERVERS)
    if not isinstance(val, dict):
        raise ValueError("agentSandbox.trustedMcpServers must be an object")
    return _deep_merge(DEFAULT_TRUSTED_MCP_SERVERS, val)


def _claude_permission_mode(policy_name, explicit_mode=None):
    if explicit_mode:
        return explicit_mode
    cfg = _sandbox_config(required=False)
    raw = cfg.get("claudePermissionModes", DEFAULT_CLAUDE_PERMISSION_MODES)
    if not isinstance(raw, dict):
        raise ValueError("agentSandbox.claudePermissionModes must be an object")
    modes = _deep_merge(DEFAULT_CLAUDE_PERMISSION_MODES, raw)
    mode = modes.get(policy_name)
    if mode is not None and not isinstance(mode, str):
        raise ValueError(f"agentSandbox.claudePermissionModes.{policy_name} must be a string")
    return mode


def resolve_sandbox_policy_name(harness, model, explicit_policy=None):
    cfg = _sandbox_config(required=False)
    policy = (
        explicit_policy
        or _match_default(cfg.get("modelDefaults"), model)
        or _match_default(cfg.get("harnessDefaults"), harness)
        or cfg.get("defaultPolicy")
        or DEFAULT_SANDBOX_POLICY
    )
    return _validate_sandbox_policy(policy)


def _live_spawn_policy(resolved_policy, explicit=False):
    # See FENCE_GLOBALLY_DISABLED. Forces unsandboxed for LIVE spawns while the
    # fence is globally off, without disturbing the pure resolver above.
    # EXCEPTION: an EXPLICIT policy request (--policy / the MCP policy arg) is
    # always honored, so the fence stays testable on a single agent without
    # flipping the global default for the whole fleet. The global-off only
    # governs the DEFAULT (capability-derived) policy.
    # HISTORY (2026-06-19): the fence blocks the tmux server socket
    # (/private/tmp/tmux-*/default → "Operation not permitted"), so fencing a
    # capability/UI spawn fenced the daemon's `tmux new-session` → NO agent could
    # spawn from the UI. ROOT CAUSE (found + fixed): the daemon
    # (bin/lib/daemon-guards.mjs) passed the capability-DERIVED policy
    # (spawnPolicy.policy, which is ALWAYS set) as --policy, so fleet-spawn read
    # every UI spawn as an explicit fence request (sandbox_policy non-None →
    # explicit=True) and fenced it even under the global-off. A first
    # explicit-honoring revert was tested by advocate and FAILED for exactly this
    # reason (a capability MCP spawn came back fenced); two emergency sledgehammers
    # (`return "unsandboxed"`) bridged the gap. NOW the root cause is fixed:
    # daemon-guards gates --policy on spawnPolicy.name (a genuinely NAMED policy),
    # so capability-derived spawns travel via --spawn-capability only and resolve
    # NON-explicitly. The explicit-honoring logic below is therefore correct:
    # default (capability/UI/MCP) → unsandboxed under the global-off; only a real
    # named --policy fences one agent; the daemon itself never fences. (The two
    # emergency `return "unsandboxed"` sledgehammers are removed now that the
    # daemon-guards fix is live — see git history if a regression recurs.)
    if explicit:
        return resolved_policy
    return "unsandboxed" if FENCE_GLOBALLY_DISABLED else resolved_policy


def _project_source_dirs_from_server():
    try:
        data = api_get("/api/projects")
    except SystemExit:
        return []
    projects = data.get("projects", []) if isinstance(data, dict) else []
    roots = []
    for p in projects:
        src = p.get("sourceDir") if isinstance(p, dict) else None
        if src and os.path.isdir(os.path.expanduser(src)):
            roots.append(os.path.abspath(os.path.expanduser(src)))
    return roots


def _project_source_dirs_from_disk():
    roots = []
    for pj in glob.glob(os.path.join(REPO_DIR, "server", "projects", "*", "project.json")):
        try:
            with open(pj) as f:
                p = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        src = p.get("sourceDir") if isinstance(p, dict) else None
        if src and os.path.isdir(os.path.expanduser(src)):
            roots.append(os.path.abspath(os.path.expanduser(src)))
    return roots


def tlda_project_source_dirs():
    roots = _project_source_dirs_from_server() or _project_source_dirs_from_disk()
    cfg = read_config().get(SANDBOX_CONFIG_KEY) or {}
    extra = cfg.get("extraProjectWriteRoots", []) if isinstance(cfg, dict) else []
    if isinstance(extra, str):
        extra = [extra]
    for src in extra:
        p = os.path.abspath(os.path.expanduser(src))
        if os.path.isdir(p):
            roots.append(p)
    return sorted(set(roots))


def path_inside(path, root):
    path = os.path.abspath(path)
    root = os.path.abspath(root)
    return path == root or path.startswith(root + os.path.sep)


def project_roots_for_cwd(cwd):
    roots = tlda_project_source_dirs()
    return roots, next((r for r in roots if path_inside(cwd, r)), None)


def sandbox_roots_for_policy(policy, cwd):
    policy = _validate_sandbox_policy(policy)
    cwd = os.path.abspath(cwd)
    if policy == "no-dev":
        return False, [], None
    if policy == "cwd":
        return True, [cwd], cwd
    if policy == "unsandboxed":
        return True, [], None
    roots, matched = project_roots_for_cwd(cwd)
    return bool(matched), roots, matched


def resolve_sandbox_policy(harness, model, cwd, write_roots, policy_name):
    policy_name = _validate_sandbox_policy(policy_name)
    if policy_name == "unsandboxed":
        raise ValueError("unsandboxed launches do not have a sandbox lease")
    cfg = _sandbox_config(required=True)
    policy_options = cfg.get("policyOptions") if isinstance(cfg.get("policyOptions"), dict) else {}
    options = _deep_merge(DEFAULT_SANDBOX_OPTIONS, policy_options.get(policy_name, {}))
    runner = _runner_from_config(cfg, required=True)
    workspace = os.path.abspath(cwd)
    configured_read_roots = _config_path_list(cfg, "readRoots", DEFAULT_SANDBOX_READ_ROOTS)
    read_roots = sorted({workspace, *configured_read_roots, *[os.path.abspath(p) for p in write_roots]})
    write_roots = sorted({os.path.abspath(p) for p in write_roots})
    return {
        "schema": 1,
        "policy": policy_name,
        "harness": harness,
        "model": model,
        "workspace": workspace,
        "read_roots": read_roots,
        "write_roots": write_roots,
        "network": _as_bool(options.get("network", False)),
        "git": options.get("git", "read"),
        "artifacts": _as_bool(options.get("artifacts", True)),
        "trusted_mcp_servers": _trusted_mcp_servers(cfg),
        "runner": runner,
    }


def resolve_harness_sandbox(harness, model, cwd, explicit_policy=None):
    policy_name = resolve_sandbox_policy_name(harness, model, explicit_policy=explicit_policy)
    dev_tools, write_roots, matched_root = sandbox_roots_for_policy(policy_name, cwd)
    policy = None
    if dev_tools and policy_name != "unsandboxed":
        policy = resolve_sandbox_policy(harness, model, cwd, write_roots, policy_name)
    return policy_name, dev_tools, write_roots, matched_root, policy


def _require_native_tools(harness, policy_name, dev_tools):
    if dev_tools:
        return
    raise ValueError(
        f'{harness} cannot satisfy sandbox policy "{policy_name}" without native '
        "developer tools. Use policy cwd/tlda-projects from an allowed root, "
        "or choose a harness with a no-dev mode."
    )


def _format_sandbox_arg(arg, policy, cmd):
    vals = {
        "workspace": policy["workspace"],
        "profile": policy["policy"],
        "policy": policy["policy"],
        "harness": policy["harness"],
        "model": policy["model"] or "",
        "network": "allow" if policy["network"] else "deny",
        "git": str(policy["git"]),
        "read_roots": os.pathsep.join(policy.get("read_roots", [])),
        "write_roots": os.pathsep.join(policy.get("write_roots", [])),
        "lease_json": json.dumps({k: v for k, v in policy.items() if k != "runner"}, sort_keys=True),
        "cmd": cmd,
    }
    return str(arg).format(**vals)


def _expand_paths(paths):
    return [os.path.abspath(os.path.expanduser(p)) if not any(ch in p for ch in "*?[]") else os.path.expanduser(p)
            for p in paths]


def _fence_settings(policy):
    allow_read = sorted(set(_expand_paths([
        *policy.get("read_roots", []),
        *FENCE_AGENT_READ_ROOTS,
    ])))
    allow_write = sorted(set(_expand_paths([
        *policy.get("write_roots", []),
        *FENCE_AGENT_WRITE_ROOTS,
    ])))
    deny_write = list(FENCE_DENY_WRITE)
    # A write-capable agent's own repo (.git is an explicit write root) needs
    # local git -- status / add / commit / branch -- as part of its job, so the
    # fence must not blanket-deny .git for it. The irrevocable and destructive
    # commands (git push / reset / clean / checkout -- / rebase / merge, the
    # publishes, sudo) stay blocked via command.deny below regardless. A
    # read-only agent has no .git write root, so .git stays read-only for it.
    repo_git_writable = str(policy.get("git", "read")) == "write" or _has_git_write_root(policy)
    if not repo_git_writable:
        deny_write.extend(FENCE_GIT_READONLY_DENY)
    allowed_domains = list(FENCE_CODE_ALLOWED_DOMAINS)
    api_host = urlparse(API).hostname
    if api_host and api_host not in allowed_domains:
        allowed_domains.append(api_host)
    # Network is ON by DEFAULT for every agent (Skip's spec: "every agent should
    # use the Internet" -- deepseek reads math papers, math/sims reach cluster
    # SSH). A normal `write` agent reaches the whole web. So when the lease grants
    # network, allow all domains; the deniedDomains below still block cloud-
    # metadata SSRF + telemetry. The OPT-IN `-no-net` restriction (which you set
    # yourself by editing the fence config, never a default) keeps the curated
    # allowlist (model APIs only): a no-net agent still reaches its model, nothing
    # else.
    if policy.get("network"):
        allowed_domains = ["*"]
    api_local_outbound = _api_needs_local_outbound()
    network = {
        "allowedDomains": allowed_domains,
        "deniedDomains": [
            "169.254.169.254",
            "metadata.google.internal",
            "instance-data.ec2.internal",
            "statsig.anthropic.com",
            "*.sentry.io",
        ],
        "allowLocalBinding": bool(policy.get("network")) or api_local_outbound,
        "allowLocalOutbound": bool(policy.get("network")) or api_local_outbound,
        # AF_UNIX connect is denied by the macOS sandbox even when
        # allowLocalOutbound (TCP loopback) is on. A fenced app agent drives the
        # shared OUT-of-fence browser by connecting to the playwright-cli daemon's
        # unix socket under TLDA_PW_SOCKETS_ROOT, so whitelist that path. See
        # TLDA_PW_SOCKETS_ROOT / cli/lib/pw.mjs.
        "allowUnixSockets": [
            TLDA_PW_SOCKETS_ROOT,
            f"{TLDA_PW_SOCKETS_ROOT}/**",
        ],
    }
    return {
        "allowPty": True,
        "network": network,
        "filesystem": {
            # Reads are PERMISSIVE: the fence constrains WRITES and network, not
            # which dirs an agent may READ. Read-fencing is what kept blocking
            # real jobs -- the macOS Keychain (Claude's OAuth token, => "Not
            # logged in" when denied), the Playwright cache, xcrun's db,
            # ~/.gitconfig. Skip 2026-06-19: "read whatever the fuck you want...
            # ideal if you weren't able to read secrets, but whatever." So:
            # default-allow read, and deny only the explicit secret FILES in
            # FENCE_DENY_READ (ssh keys, aws/gcloud/kube creds, .netrc,
            # git-credentials). denyRead takes precedence over the default.
            "defaultDenyRead": False,
            "allowRead": allow_read,
            "denyRead": FENCE_DENY_READ,
            "allowWrite": allow_write,
            "denyWrite": deny_write,
        },
        "command": {
            "deny": [] if str(policy.get("git")) == "write" else FENCE_COMMAND_DENY,
            "useDefaults": True,
        },
    }


def _write_fence_settings(policy):
    lease = {k: v for k, v in policy.items() if k != "runner"}
    settings = _fence_settings(policy)
    settings["_tldaLease"] = lease
    lease_dir = os.path.join(tempfile.gettempdir(), "tlda-fence-leases")
    os.makedirs(lease_dir, exist_ok=True)
    name = f"{policy['harness']}-{policy['policy']}-{uuid.uuid4().hex}.json"
    path = os.path.join(lease_dir, name)
    with open(path, "w") as f:
        json.dump(settings, f, indent=2, sort_keys=True)
        f.write("\n")
    return path


def _wrap_fence_cmd(cmd, policy, runner):
    settings_path = _write_fence_settings(policy)
    argv = [
        runner.get("command") or "fence",
        "--settings",
        settings_path,
        "--",
        runner.get("shell", "zsh"),
        "-lc",
        cmd,
    ]
    return shlex.join(argv)


def wrap_sandbox_cmd(cmd, policy):
    runner = policy["runner"]
    command = runner.get("command")
    if not command:
        raise ValueError("agentSandbox.runner.command is required")
    tmp_root = "/tmp/tlda-fence-env"
    os.makedirs(tmp_root, exist_ok=True)
    xdg_config_home = os.path.join(tmp_root, "xdg")
    os.makedirs(os.path.join(xdg_config_home, "git"), exist_ok=True)
    empty_gitconfig = os.path.join(tmp_root, "empty-gitconfig")
    empty_gitignore = os.path.join(xdg_config_home, "git", "ignore")
    open(empty_gitconfig, "a").close()
    open(empty_gitignore, "a").close()

    env = {
        "TLDA_SANDBOX_PROFILE": policy["policy"],
        "TLDA_SANDBOX_POLICY": policy["policy"],
        "TLDA_SANDBOX_LEASE": json.dumps({k: v for k, v in policy.items() if k != "runner"}, sort_keys=True),
        # Keep common Git reads inside fence's existing /tmp allowance. macOS
        # /usr/bin/git otherwise asks xcrun to read /var/folders/.../xcrun_db,
        # then Git tries ~/.gitconfig, both outside a cwd-scoped fence.
        "TMPDIR": tmp_root,
        "GIT_CONFIG_GLOBAL": empty_gitconfig,
        "GIT_CONFIG_NOSYSTEM": "1",
        "XDG_CONFIG_HOME": xdg_config_home,
        "xcrun_nocache": "1",
    }
    xcode_usr_bin = "/Applications/Xcode.app/Contents/Developer/usr/bin"
    if os.path.exists(os.path.join(xcode_usr_bin, "git")):
        env["PATH"] = f"{xcode_usr_bin}:{os.environ.get('PATH', '')}"
        env["DEVELOPER_DIR"] = "/Applications/Xcode.app/Contents/Developer"
    prefix = " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items())
    inner_cmd = f"{prefix} {cmd}"

    if os.path.basename(command) == "fence" and not runner.get("args"):
        wrapped = _wrap_fence_cmd(inner_cmd, policy, runner)
    else:
        args = [_format_sandbox_arg(a, policy, inner_cmd) for a in runner.get("args", [])]
        argv = [command, *args]
        if "{cmd}" not in " ".join(map(str, runner.get("args", []))):
            shell = runner.get("shell", "zsh")
            argv.extend(["--", shell, "-lc", inner_cmd])
        wrapped = shlex.join(argv)
    return f"{prefix} {wrapped}"


def sandbox_metadata(policy):
    if not policy:
        return {}
    return {"sandbox": {k: v for k, v in policy.items() if k != "runner"}}


def spawn_policy_metadata(spawn_capability, policy_name):
    if not spawn_capability:
        return {}
    return {"spawnPolicy": {
        "capability": spawn_capability,
        "policy": policy_name,
    }}


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
    # DNS alias for the tlda server host (same as codex/goose). Claude passes its
    # process env down to the tlda MCP subprocess, so this reaches the MCP's node.
    # It matters under the FENCE: the sandbox can't resolve the Tailscale MagicDNS
    # name (`getaddrinfo ENOTFOUND`), so the MCP's fleet WSS would die ("fleet WS:
    # ✘") even though HTTPS-via-proxy works. The preload aliases the one API host to
    # its tailnet IP so node skips getaddrinfo. No-op for unsandboxed agents (the
    # host resolver already returns that IP).
    dns_alias = _resolve_api_dns_alias()
    if dns_alias and os.path.exists(NODE_DNS_ALIAS_PRELOAD):
        host, address = dns_alias
        parts.append(f"NODE_OPTIONS={shlex.quote(f'--require={NODE_DNS_ALIAS_PRELOAD}')}")
        parts.append(f"TLDA_NODE_DNS_ALIAS_HOST={shlex.quote(host)}")
        parts.append(f"TLDA_NODE_DNS_ALIAS_ADDR={shlex.quote(address)}")
    parts.append("claude")
    if resume_id:
        parts.append(f"--resume {resume_id}")
    parts.append("--dangerously-load-development-channels server:tlda")
    parts.append(f"--model '{model}'")
    if effort:
        parts.append(f"--effort '{effort}'")
    if mode == "bypassPermissions":
        # bypassPermissions via --permission-mode shows a blocking interactive
        # "Yes, I accept" dialog on EVERY boot (no persisted skip-flag), which
        # hangs a fleet spawn. --dangerously-skip-permissions is the non-
        # interactive equivalent: bypass all permission checks, no dialog. The
        # fence is the real guardrail (that's the whole point), so skipping
        # Claude's prompts is exactly intended. Claude's own warning says this
        # mode is for a sandboxed environment -- which under the fence it is.
        parts.append("--dangerously-skip-permissions")
    elif mode:
        parts.append(f"--permission-mode '{mode}'")
    if include_prompt:
        parts.append(shlex.quote(register_prompt(name)))
    return " ".join(parts)



# Restrictive instruction sentences in the base deepseek recipe that tell a goose
# it cannot write. For a write-capable goose we swap these for write-positive
# guidance so it actually USES the developer tool. Kept as exact-match constants
# so a recipe edit that breaks the match fails loudly in the test, not silently.
_GOOSE_NOWRITE_LINE = (
    "interface. You have no shell and no general file editing; everything you can\n"
    "  do, you do through the fleet (`tlda`) MCP tools."
)
_GOOSE_WRITE_LINE = (
    "interface, plus a developer tool. You CAN write and edit files and run shell\n"
    "  commands within your sandboxed workspace; the fence constrains WHERE you may\n"
    "  write (your project lane). You also have the fleet (`tlda`) MCP tools."
)
_GOOSE_NOWRITE_BULLET = (
    "  - You cannot edit arbitrary files or run shell commands. If you need to produce\n"
    "    written output, put it in a scratch file via the scratch tools, or say it in\n"
    "    `chat`. Never claim to have changed something you cannot change."
)
_GOOSE_WRITE_BULLET = (
    "  - You CAN edit files and run shell commands within your sandboxed workspace\n"
    "    via the developer tool. Write real output to disk where the task needs it;\n"
    "    the fence keeps you in your lane. Never claim to have changed something you\n"
    "    did not actually change."
)


def goose_capability_launch(base_recipe, state_dir, capability):
    """Return (recipe_path, extra_goose_args) for a goose spawn at `capability`.

    Skip's fence+harness coupling, BOTH HALVES gated together:
      * write / tlda-write / full -> the developer (shell+fs) builtin is added via
        `--with-builtin developer`, AND a per-agent recipe whose instructions tell
        the agent it MAY write its workspace. A tool with a "don't write"
        instruction is still no write, so both move as one.
      * read (or unset) -> the base recipe (tlda-MCP-only instructions) and NO
        builtin. Neither half.

    `--with-builtin developer` is the only thing that actually loads the tool when
    goose runs with --recipe — verified live that the recipe's `extensions:` block
    and the sandbox profile's developer.enabled do NOT. The fence
    (wrap_sandbox_cmd write_roots) still constrains WHERE; the tool does not bypass
    it. Dependency: under the global fence-off a write goose is shell+fs
    unsandboxed (same risk as every other agent tonight, not net-new); the restored
    fence (#6/D2, operator's gate) makes it dev-tools-on AND fenced — not flipped
    here.
    """
    if normalize_spawn_capability(capability) not in ("write", "tlda-write", "full"):
        return base_recipe, []
    try:
        with open(base_recipe) as f:
            text = f.read()
    except OSError:
        return base_recipe, ["--with-builtin developer"]  # tool at least
    text = text.replace(_GOOSE_NOWRITE_LINE, _GOOSE_WRITE_LINE, 1)
    text = text.replace(_GOOSE_NOWRITE_BULLET, _GOOSE_WRITE_BULLET, 1)
    os.makedirs(state_dir, exist_ok=True)
    per_recipe = os.path.join(state_dir, "fleet-deepseek.yaml")
    tmp = per_recipe + f".tmp-{os.getpid()}"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, per_recipe)
    return per_recipe, ["--with-builtin developer"]


def build_goose_cmd(fleet_id, tmux_session, model, name=None, capability=None):
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
    state_dir = os.path.join(GOOSE_STATE_ROOT, str(fleet_id).replace(":", "-"))
    data_dir = os.path.join(state_dir, "data")
    cache_dir = os.path.join(state_dir, "cache")
    xdg_state_dir = os.path.join(state_dir, "state")
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(cache_dir, exist_ok=True)
    os.makedirs(xdg_state_dir, exist_ok=True)
    # Capability decides whether the developer (shell+fs) extension boots and
    # whether the instructions permit writing: a write/tlda-write/full goose gets
    # the developer builtin AND a per-agent recipe whose instructions allow
    # writing its workspace (still fenced by wrap_sandbox_cmd); a read goose gets
    # neither (tlda-MCP-only). Both halves move together.
    recipe, dev_args = goose_capability_launch(recipe, state_dir, capability)
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
        f"XDG_DATA_HOME={shlex.quote(data_dir)}",
        f"XDG_CACHE_HOME={shlex.quote(cache_dir)}",
        f"XDG_STATE_HOME={shlex.quote(xdg_state_dir)}",
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
    parts.extend(dev_args)  # --with-builtin developer for write-capable goose
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


def codex_sandbox_for_capability(capability, outer_sandbox=False):
    """Map a fleet spawn capability to a Codex `-s` sandbox mode.

    Mirrors projectCapabilityToMode in server/lib/spawn-policy.mjs. Without this,
    build_codex_cmd hardcoded `-s workspace-write`, so a `full-access` codex agent
    launched sandboxed at workspace-write — the grant was recorded in
    meta.spawnPolicy but never reached the codex process (it then couldn't bind
    sockets / launch a browser). full-access → danger-full-access closes that gap."""
    if outer_sandbox:
        # Fence is the fleet permission model. Avoid nesting Codex's macOS
        # sandbox inside fence; nested sandbox-exec fails before commands run.
        return "danger-full-access"
    cap = normalize_spawn_capability(capability)
    if cap == "full":
        return "danger-full-access"
    if cap == "read":
        return "read-only"
    # write / tlda-write / unset → codex's middle tier. (read-only,
    # workspace-write, danger-full-access are Codex's OWN API vocabulary — the one
    # foreign-API boundary where a non-tlda string legitimately survives.)
    return "workspace-write"


def codex_workspace_write_config_args(capability, cwd=None):
    """Extra Codex sandbox config for fleet capability levels.

    `-s workspace-write` alone only gives file-write access inside the checkout.
    Codex keeps `.git` read-only unless it is an explicit writable root, and the
    TLDA daemon/server controls live under ~/.config/tlda. A manager-capable
    `workspace-write` agent needs both: commit checkpoints and inspect/control
    the local TLDA service without escalating all the way to danger-full-access.
    """
    if normalize_spawn_capability(capability) not in ("write", "tlda-write"):
        return []
    args = ["-c " + shlex.quote("sandbox_workspace_write.network_access=true")]
    workdir = cwd or os.getcwd()
    roots = [
        os.path.expanduser("~/.config/tlda"),
        os.path.join(workdir, ".git"),
    ]
    args.append("-c " + shlex.quote(f"sandbox_workspace_write.writable_roots={json.dumps(roots, separators=(',', ':'))}"))
    return args


def _toml_basic_string(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"') + '"'


def ensure_codex_project_trusted(cwd, config_file=CODEX_CONFIG_FILE):
    """Pre-seed Codex project trust for UI/fleet spawned agents."""
    if not cwd:
        return False
    project = os.path.realpath(os.path.expanduser(cwd))
    section = f'[projects.{_toml_basic_string(project)}]'
    try:
        with open(config_file) as f:
            text = f.read()
    except FileNotFoundError:
        text = ""

    section_re = re.compile(
        rf'(?ms)^(?P<header>{re.escape(section)}\s*\n)(?P<body>.*?)(?=^\[|\Z)'
    )
    match = section_re.search(text)
    if match:
        body = match.group("body")
        if re.search(r'(?m)^\s*trust_level\s*=\s*"trusted"\s*(?:#.*)?$', body):
            return False
        if re.search(r'(?m)^\s*trust_level\s*=', body):
            body = re.sub(r'(?m)^\s*trust_level\s*=.*$', 'trust_level = "trusted"', body, count=1)
        else:
            body = f'trust_level = "trusted"\n{body}'
        text = text[:match.start("body")] + body + text[match.end("body"):]
    else:
        prefix = "" if not text or text.endswith("\n") else "\n"
        text = f'{text}{prefix}\n{section}\ntrust_level = "trusted"\n'

    os.makedirs(os.path.dirname(config_file), exist_ok=True)
    tmp = f"{config_file}.tmp-{os.getpid()}"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, config_file)
    return True


def _resolve_api_dns_alias():
    host = urlparse(API).hostname
    if not host or host in ("localhost", "127.0.0.1", "::1"):
        return None
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except OSError as e:
        print(f"  warning: could not pre-resolve {host} for fenced Node MCP DNS: {e}", file=sys.stderr)
        return None
    addresses = []
    for family, _type, _proto, _canon, sockaddr in infos:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        address = sockaddr[0]
        if address not in addresses:
            addresses.append(address)
    if not addresses:
        return None
    # Prefer IPv4: the Fly tailnet route is verified on the 100.x address, and
    # Node callers that request a scalar lookup need one deterministic answer.
    address = next((addr for addr in addresses if "." in addr), addresses[0])
    return host, address


def _api_needs_local_outbound():
    alias = _resolve_api_dns_alias()
    if not alias:
        return False
    _host, address = alias
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return (
        ip.is_loopback
        or ip.is_link_local
        or ip.is_private
        or ip in ipaddress.ip_network("100.64.0.0/10")
    )


def _has_git_write_root(policy):
    """True if the policy makes an agent's own .git directory a writable root.

    apply_spawn_capability_to_policy adds <cwd>/.git to write_roots for a
    project-write capability, so this is how we tell an agent that legitimately
    needs local git (commit/add/branch) apart from a read-only one. The
    irrevocable/destructive git commands stay denied via FENCE_COMMAND_DENY
    regardless of this.
    """
    for root in policy.get("write_roots") or []:
        if os.path.basename(os.path.normpath(str(root))) == ".git":
            return True
    return False


def apply_spawn_capability_to_policy(policy, capability, cwd):
    if not policy:
        return policy
    cap = normalize_spawn_capability(capability)
    if cap == "read":
        policy["write_roots"] = []
        return policy
    # write and tlda-write both get the dev write-roots below; the broader
    # tlda-projects breadth for tlda-write is added by its sandbox region
    # (sandbox_roots_for_policy('tlda-projects')), not here. full leaves the
    # policy unfenced.
    if cap not in ("write", "tlda-write"):
        return policy
    policy["network"] = True
    roots = set(policy.get("write_roots") or [])
    roots.add(os.path.abspath(os.path.expanduser("~/.config/tlda")))
    roots.add(os.path.abspath(PLAYWRIGHT_CACHE_ROOT))
    roots.add(os.path.abspath(TLDA_FENCE_TMP_ROOT))
    if cwd:
        roots.add(os.path.abspath(os.path.join(cwd, ".git")))
    policy["write_roots"] = sorted(roots)
    policy["read_roots"] = sorted(set(policy.get("read_roots") or []) | roots)
    return policy


def sandbox_policy_for_spawn_capability(capability):
    # The fence region travels INSIDE the four-name rung now (tlda-write carries
    # its own tlda-projects region; it is no longer a separate --policy arg).
    cap = normalize_spawn_capability(capability)
    if cap == "full":
        return "unsandboxed"
    if cap == "tlda-write":
        return "tlda-projects"
    if cap in ("read", "write"):
        return "cwd"
    return None


def build_codex_cmd(fleet_id, tmux_session, model=None, resume_id=None,
                    include_prompt=True, name=None, cwd=None, capability=None,
                    outer_sandbox=False):
    """Build the shell command for an OpenAI Codex CLI fleet agent.

    Mirrors build_claude_cmd: same identity env (FLEET_ID/FLEET_NAME/TMUX) on
    EVERY launch including resume (spec K.1 — the resumed process recovers its
    fleet id from the re-injected env, never by parsing the transcript), then
    launches `codex` interactively in the tmux pane so the wake machinery
    (send-keys) drives it like a claude agent.

    Auth: Codex authenticates from ~/.codex/auth.json (ChatGPT subscription
    sign-in), NOT from the environment — so unlike goose there's no API key to
    source from a login shell, and no zsh -lc wrapper is needed.

    MCP env — THE KEY DIFFERENCE FROM CLAUDE (verified 2026-06-15): Codex does
    NOT pass the launch process env down to its MCP subprocess (Claude does). So
    setting FLEET_ID/TLDA_SERVER as a process-env prefix would NOT reach the tlda
    MCP server — it'd register under a random id and hit the wrong server. We
    inject the MCP env via Codex's `-c mcp_servers.tlda.env.<KEY>=<val>` config
    override instead (confirmed: the MCP subprocess sees exactly these, and a
    process-env value does NOT leak in). Per-invocation, so no shared-config race.
    The `[mcp_servers.tlda]` server entry itself (command/args) is one-time setup
    in ~/.codex/config.toml; only the per-agent env is injected here.

    Flags:
      -m <model>        the Codex model (omit to use the subscription default)
      -s workspace-write let the agent edit files in its cwd (parity with claude)
      -a never          don't pause for shell-command approval (autonomous)

    TWO ITEMS NEED LIVE INTERACTIVE VERIFICATION (with ops, daemon auto-accept):
      1. MCP tool-call approval — Codex raises an *elicitation* for MCP tools that
         `codex exec` auto-cancels; interactively it surfaces as a prompt the
         daemon's autoAcceptPrompt path must learn to answer (fleet-daemon.mjs:566).
      2. Project trust — first interactive run in an untrusted dir prompts to
         trust; either pre-seed `[projects.<cwd>] trust_level="trusted"` in config
         or let the daemon auto-accept answer it.
    These don't change this command's shape; they're daemon-side and tracked
    separately.
    """
    # Identity in process env: FLEET_ID/TMUX/NAME so `ps` (the daemon's liveness
    # + classification scan) can see which fleet agent a codex process is. These
    # do NOT reach the MCP subprocess (see docstring) — that's the -c block below.
    dns_alias = _resolve_api_dns_alias()
    process_env = [
        f"FLEET_ID={fleet_id}",
        f"FLEET_TMUX_SESSION={tmux_session}",
    ]
    if name:
        process_env.append(f"FLEET_NAME={shlex.quote(name)}")
    if dns_alias and os.path.exists(NODE_DNS_ALIAS_PRELOAD):
        host, address = dns_alias
        process_env.append(f"NODE_OPTIONS={shlex.quote(f'--require={NODE_DNS_ALIAS_PRELOAD}')}")
        process_env.append(f"TLDA_NODE_DNS_ALIAS_HOST={shlex.quote(host)}")
        process_env.append(f"TLDA_NODE_DNS_ALIAS_ADDR={shlex.quote(address)}")
    parts = list(process_env)
    parts.append("codex")
    if resume_id:
        # Resume keeps the same fleet id (re-injected below) and continues the
        # prior rollout WITH context. Do not pass the bootstrap as the optional
        # trailing PROMPT here: Codex treats a positional prompt as a one-shot
        # turn and may exit after completing it. fleet-spawn starts the TUI
        # first, then injects register/my_task with tmux send-keys.
        parts.append(f"resume {shlex.quote(resume_id)}")
    # MCP env via -c overrides — the ONLY channel that reaches the tlda MCP server.
    def _cenv(key, val):
        return f"-c {shlex.quote(f'mcp_servers.tlda.env.{key}={val}')}"
    parts.append(_cenv("FLEET_ID", fleet_id))
    if name:
        parts.append(_cenv("FLEET_NAME", name))
    # FLEET_HARNESS=codex → the MCP delivers incoming messages via a send-keys
    # nudge into the pane (like goose), not the Claude-only channel notification.
    parts.append(_cenv("FLEET_HARNESS", "codex"))
    # The send-keys nudge targets process.env.FLEET_TMUX_SESSION. The process-level
    # FLEET_TMUX_SESSION above does NOT reach the MCP subprocess (codex passes only
    # the -c overrides), so inject it here too — without it the nudge silently
    # no-ops and the agent never wakes on an incoming chat.
    parts.append(_cenv("FLEET_TMUX_SESSION", tmux_session))
    parts.append(_cenv("TLDA_SERVER", API))
    parts.append(_cenv("TLDA_SYNC_SERVER", API))
    if dns_alias and os.path.exists(NODE_DNS_ALIAS_PRELOAD):
        host, address = dns_alias
        parts.append(_cenv("NODE_OPTIONS", f"--require={NODE_DNS_ALIAS_PRELOAD}"))
        parts.append(_cenv("TLDA_NODE_DNS_ALIAS_HOST", host))
        parts.append(_cenv("TLDA_NODE_DNS_ALIAS_ADDR", address))
    parts.extend(codex_workspace_write_config_args(capability, cwd=cwd))
    if model:
        parts.append(f"-m {shlex.quote(model)}")
    if cwd:
        parts.append(f"-C {shlex.quote(cwd)}")
    parts.append(f"-s {codex_sandbox_for_capability(capability, outer_sandbox=outer_sandbox)}")
    parts.append("-a never")
    return " ".join(parts)


class HarnessAdapter:
    """Per-harness spawn behavior. Keep existing command builders intact; route
    call sites through one adapter selected by metadata.kind / spawn kind."""
    kind = None
    process_re = None

    def owns_model(self, model):
        return False

    def resolve_model(self, model):
        raise NotImplementedError

    def warn_model(self, model):
        return None

    def build_cmd(self, fleet_id, sess, model, effort=None, mode=None,
                  resume_id=None, include_prompt=True, name=None, cwd=None,
                  capability=None, outer_sandbox=False):
        raise NotImplementedError

    def fresh_label(self):
        return self.kind

    def refresh_auto_dismiss(self):
        return True

    def respawn_auto_dismiss(self):
        return False

    def spawn_send_keys(self):
        return False

    def find_resume(self, agent, session_override=None):
        return None

    def adjust_resume_cwd(self, cwd, handle):
        return cwd

    def resume_id(self, handle):
        return None

    def after_resume_started(self, sess, name, resume_id):
        return

    def resume_not_found_is_error(self):
        return False

    def no_resume_message(self):
        return "no resume handle found — fresh"

    def list_models(self):
        return []


class ClaudeHarness(HarnessAdapter):
    kind = "claude"
    process_re = re.compile(r"(?:^|\s|/)claude(?:\s|$)")

    def resolve_model(self, model):
        return resolve_model(model)

    def build_cmd(self, fleet_id, sess, model, effort=None, mode=None,
                  resume_id=None, include_prompt=True, name=None, cwd=None,
                  capability=None, outer_sandbox=False):
        return build_claude_cmd(
            fleet_id, sess, model, effort, mode,
            resume_id=resume_id, include_prompt=include_prompt, name=name)

    def find_resume(self, agent, session_override=None):
        if session_override:
            return {"sessionId": session_override}
        result = find_valid_session(agent)
        if not result:
            return None
        session_id, jsonl_cwd = result
        return {"sessionId": session_id, "cwd": jsonl_cwd}

    def adjust_resume_cwd(self, cwd, handle):
        return handle.get("cwd") or cwd

    def resume_id(self, handle):
        return handle["sessionId"]

    def after_resume_started(self, sess, name, resume_id):
        verify_session(sess, f"session {resume_id}")
        inject_prompt(sess, register_prompt(name))

    def resume_not_found_is_error(self):
        return True

    def no_resume_message(self):
        return "No valid session to resume"

    def list_models(self):
        return [
            {"alias": a, "id": mid, "verified": True, "kind": self.kind}
            for a, mid in sorted(MODEL_ALIASES.items())
        ]


class GooseHarness(HarnessAdapter):
    kind = "goose"
    process_re = re.compile(r"(?:^|\s|/)goose(?:\s|$)")

    def owns_model(self, model):
        return resolve_goose_model(model) is not None

    def resolve_model(self, model):
        resolved = resolve_goose_model(model)
        if resolved:
            return resolved
        if not model:
            return GOOSE_MODELS["deepseek"]
        raise ValueError(f"Unknown goose model: {model!r}. Valid: {', '.join(sorted(GOOSE_MODELS))} or vendor/model")

    def warn_model(self, model):
        if not goose_model_verified(model):
            return ("  Warning: '{model}' is not on the verified tool-calling "
                    "list — it may narrate tool-calls as text instead of invoking "
                    "them. Probe it with: bin/verify-goose-toolcalls.mjs {model}").format(model=model)
        return None

    def build_cmd(self, fleet_id, sess, model, effort=None, mode=None,
                  resume_id=None, include_prompt=True, name=None, cwd=None,
                  capability=None, outer_sandbox=False):
        return build_goose_cmd(fleet_id, sess, model, name=name, capability=capability)

    def no_resume_message(self):
        return "goose fresh re-brief"

    def list_models(self):
        return [
            {"alias": a, "id": mid, "verified": goose_model_verified(mid), "kind": self.kind}
            for a, mid in sorted(GOOSE_MODELS.items())
        ]


class CodexHarness(HarnessAdapter):
    kind = "codex"
    process_re = re.compile(r"(?:^|\s|/)codex(?:\s|$)")

    def resolve_model(self, model):
        if not model:
            return CODEX_MODELS["gpt"]
        return CODEX_MODELS.get(model, model)

    def build_cmd(self, fleet_id, sess, model, effort=None, mode=None,
                  resume_id=None, include_prompt=True, name=None, cwd=None,
                  capability=None, outer_sandbox=False):
        return build_codex_cmd(
            fleet_id, sess, model=model, resume_id=resume_id,
            include_prompt=include_prompt, name=name, cwd=cwd,
            capability=capability, outer_sandbox=outer_sandbox)

    def find_resume(self, agent, session_override=None):
        if session_override:
            if not _codex_rollout_path(session_override):
                return None
            return {"kind": "codex", "rolloutId": session_override}
        return find_codex_rollout(agent)

    def adjust_resume_cwd(self, cwd, handle):
        handle_cwd = handle.get("cwd") if handle else None
        return handle_cwd if handle_cwd and os.path.isdir(handle_cwd) else cwd

    def resume_id(self, handle):
        return handle.get("rolloutId") if handle else None

    def no_resume_message(self):
        return "no rollout found — fresh"

    def spawn_send_keys(self):
        return True

    def list_models(self):
        return [
            {"alias": a, "id": mid, "verified": True, "kind": self.kind}
            for a, mid in sorted(CODEX_MODELS.items())
        ]


HARNESS_ADAPTERS = {
    "claude": ClaudeHarness(),
    "goose": GooseHarness(),
    "codex": CodexHarness(),
}


def infer_harness_kind(kind, model):
    """Keep stale callers from routing Codex models through Claude.

    Older MCP/server processes may omit --kind while still passing a Codex model.
    fleet-spawn.py is re-exec'd for every spawn, so this lowest-layer inference
    makes the dispatch robust until all upstream processes are reloaded.
    """
    if kind and kind != "claude":
        return kind
    if model and re.match(r"^gpt(?:[-_.]|$)", model):
        return "codex"
    return kind or "claude"


def harness_for_spawn(kind, model):
    kind = infer_harness_kind(kind, model)
    if kind and kind != "claude":
        if kind not in HARNESS_ADAPTERS:
            raise ValueError(f"Unknown harness kind: {kind!r}")
        return HARNESS_ADAPTERS[kind]
    if HARNESS_ADAPTERS["goose"].owns_model(model):
        return HARNESS_ADAPTERS["goose"]
    return HARNESS_ADAPTERS["claude"]


def harness_for_agent(agent, model=None):
    meta = agent_meta(agent)
    kind = infer_harness_kind(meta.get("kind"), model or meta.get("model"))
    if not kind:
        name = agent.get("friendly_name") or agent.get("id") or "<unknown>"
        raise ValueError(f"Agent {name} has no metadata.kind; run the harness-kind backfill before respawn/refresh")
    adapter = HARNESS_ADAPTERS.get(kind)
    if not adapter:
        raise ValueError(f"Unknown harness kind for {agent.get('id')}: {kind!r}")
    return adapter


def _session_has_runtime(session):
    """Check if a tmux session has any registered harness runtime process.

    This is the spawn-side hibernation guard: if a live Claude/Codex/Goose
    runtime is already in the pane, do not clobber it with respawn-pane."""
    try:
        r = subprocess.run(tmux("list-panes", "-t", session, "-F", "#{pane_pid}"),
                           capture_output=True, text=True, timeout=5)
        if r.returncode != 0:
            return False
        pane_pids = [p for p in r.stdout.strip().split() if p]
        if not pane_pids:
            return False
        ps = subprocess.run(["ps", "-eo", "pid,ppid,args"],
                            capture_output=True, text=True, timeout=5)
        if ps.returncode != 0:
            return False
        children_by_ppid = {}
        args_by_pid = {}
        for line in ps.stdout.splitlines():
            m = re.match(r"\s*(\d+)\s+(\d+)\s+(.+)$", line)
            if not m:
                continue
            pid, ppid, args = m.groups()
            children_by_ppid.setdefault(ppid, []).append(pid)
            args_by_pid[pid] = args
        stack = list(pane_pids)
        seen = set()
        while stack:
            pid = stack.pop()
            if pid in seen:
                continue
            seen.add(pid)
            args = args_by_pid.get(pid, "")
            if any(adapter.process_re.search(args) for adapter in HARNESS_ADAPTERS.values()):
                return True
            stack.extend(children_by_ppid.get(pid, []))
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

def dismiss_devchannels(session, timeout=60):
    """Poll the pane and dismiss the dev-channels confirmation dialog (option 1)
    the moment it appears. Bounded by `timeout` so it can't loop forever — that
    was the original over-correction. Returns early once the ❯ prompt is up with
    no dialog, so a no-dialog start doesn't wait the full timeout.

    The fresh-spawn path previously fired a single blind keystroke at t=3s; when
    Claude Code was slow the dialog appeared later and the agent hung. This polls
    instead, the same way the resume path (inject_prompt) already does."""
    deadline = time.time() + timeout
    # Don't trust a "no dialog" pane in the first few seconds. The no-dialog
    # early-return below keys off a ❯ with no 'Enter to confirm', but a ❯ can be
    # on screen BEFORE the dev-channels dialog renders — Claude Code's early
    # welcome/hint paint, or (on the respawn-pane path) stale content from the
    # prior pane that hasn't repainted yet. Bailing then leaves the real dialog
    # unattended and the agent hangs at boot (the intermittent drill-subject
    # hang). The dialog reliably shows within the first seconds, so a short grace
    # window before trusting a no-dialog prompt closes that race; the timeout
    # bump (above) separately covers a dialog that appears late under spawn load.
    no_dialog_ok_at = time.time() + 8
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
                # ❯ prompt up and no dialog pending — nothing to dismiss. Only
                # trust this after the grace window, so stale pre-repaint pane
                # content can't trigger a premature bail (see above).
                if (time.time() > no_dialog_ok_at
                        and 'Enter to confirm' not in pane
                        and any('❯' in l for l in pane.splitlines()[-3:])):
                    return False
        except Exception:
            pass
        time.sleep(0.5)
    return False


def spawn_tmux(session, cwd, cmd, auto_dismiss=True, send_keys=False):
    """Start a tmux session running cmd. When auto_dismiss=True, backgrounds
    a process to dismiss the dev-channels confirmation dialog.

    Some TUIs, notably Codex resume, fail when tmux launches them as the pane's
    direct command but work when pasted into an interactive shell. send_keys=True
    keeps the same stale-session/alive-runtime guard, then starts a shell pane and
    submits cmd through it.
    """
    # Try respawn-pane first — handles dead panes left by remain-on-exit.
    # Falls back to new-session when no session exists.
    # TMUX is cleared in env so tmux doesn't print the "sessions should be
    # nested with care" warning when fleet-spawn is invoked from inside an
    # existing tmux session (e.g. an agent calling mcp__tlda__spawn).
    spawn_env = {**os.environ, "TMUX": ""}
    respawn_args = tmux("respawn-pane", "-t", session, "-c", cwd)
    if not send_keys:
        respawn_args.append(cmd)
    r = subprocess.run(respawn_args, capture_output=True, timeout=5, env=spawn_env)
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
        if _session_has_runtime(session):
            return False  # already alive — do not restart, do not inject
        # Dead pane / stale session: kill it so the fallback starts fresh.
        # kill-session on a missing session is a no-op.
        subprocess.run(tmux("kill-session", "-t", session),
                       capture_output=True, timeout=5, env=spawn_env)
        new_args = tmux("new-session", "-d", "-s", session, "-c", cwd)
        if not send_keys:
            new_args.append(cmd)
        subprocess.run(new_args, check=True, env=spawn_env)
        subprocess.run(tmux("set-option", "-t", session, "remain-on-exit", "on"),
                       capture_output=True, timeout=5, env=spawn_env)
    # Pin the window to a fixed width so the agent always paints at one size. The
    # global window-size=latest makes the window follow whatever client last
    # attached; an idle agent's frame is then painted at one width and shown in the
    # terminal peek's grid at a different (current) width -> absolute-position
    # garble. Manual + a fixed size removes the reflow at the source.
    subprocess.run(tmux("set-option", "-t", session, "window-size", "manual"),
                   capture_output=True, timeout=5, env=spawn_env)
    subprocess.run(tmux("resize-window", "-t", session, "-x", "120", "-y", "40"),
                   capture_output=True, timeout=5, env=spawn_env)
    if send_keys:
        # The freshly-spawned login shell may still be sourcing its rc files when
        # these keys arrive. Pasting the full (~1KB) launch command then races the
        # shell's tty read: the canonical input buffer (MAX_CANON ≈ 1024 bytes)
        # overflows and the TAIL is dropped, truncating the `zsh -lc '…codex…'`
        # mid-single-quote. The shell then sits at `quote>` forever, codex never
        # launches, and the agent never registers ("spawn started, never
        # registered"). Stage the command in a launch script and paste only a
        # short `source <path>` line: a tiny paste can't overflow the buffer and
        # is safely buffered even mid-startup, so the full command always runs.
        import tempfile
        fd, _launch = tempfile.mkstemp(prefix='tlda-launch-', suffix='.sh')
        with os.fdopen(fd, 'w') as _f:
            _f.write(cmd + '\n')
        subprocess.run(tmux("send-keys", "-t", session, "--", f"source {_launch}"),
                       check=True, timeout=5, env=spawn_env)
        subprocess.run(tmux("send-keys", "-t", session, "Enter"),
                       check=True, timeout=5, env=spawn_env)
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


def inject_codex_prompt(session, prompt, timeout=60):
    """Wait for the Codex TUI input prompt, then inject the fleet bootstrap.

    Passing the bootstrap as `codex [PROMPT]` / `codex resume [PROMPT]` makes
    Codex behave like a one-shot turn in some cases. Keeping the launch command
    prompt-free and typing into the live TUI preserves the interactive agent.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = subprocess.run(
                tmux("capture-pane", "-t", session, "-p"),
                capture_output=True, text=True, timeout=5)
            if r.returncode != 0:
                time.sleep(1)
                continue
            pane = r.stdout.rstrip()
            lines = pane.split('\n')
            if 'Do you trust the contents of this directory?' in pane:
                subprocess.run(tmux("send-keys", "-t", session, "Enter"), capture_output=True, timeout=5)
                time.sleep(1)
                continue
            prompt_ready = any('›' in l for l in lines[-5:])
            busy = any(marker in pane for marker in ('Working', 'Transmuting', 'Thinking'))
            if prompt_ready and not busy:
                subprocess.run(tmux("send-keys", "-t", session, "C-u"), capture_output=True, timeout=5)
                time.sleep(0.2)
                subprocess.run(tmux("send-keys", "-t", session, prompt), capture_output=True, timeout=5)
                time.sleep(0.3)
                subprocess.run(tmux("send-keys", "-t", session, "Enter"), capture_output=True, timeout=5)
                return True
        except Exception:
            pass
        time.sleep(1)
    print(f"  Warning: timed out waiting for Codex prompt in {session}", file=sys.stderr)
    return False


# ---- Spawn modes ----

def _check_fresh_name_available(name, server_up):
    if not server_up:
        return
    existing = find_agent(name)
    if existing:
        print(f"Error: '{name}' already exists ({existing['id']}). "
              f"Use: fleet-spawn {name}", file=sys.stderr)
        sys.exit(1)
    collisions = check_name_collisions(name)
    if not collisions:
        return
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


def fresh(name, model, cwd, effort, mode, kind="claude", spawn_capability=None,
          sandbox_policy=None):
    server_up = ensure_server()
    fleet_id = f"fleet:{uuid.uuid4().hex[:8]}"
    sess = unique_session_name(f"fleet-{sanitize_session_name(name)}")
    cwd = resolve_spawn_cwd(cwd)
    adapter = harness_for_spawn(kind, model)
    model = adapter.resolve_model(model)
    effective_policy = _live_spawn_policy(sandbox_policy or sandbox_policy_for_spawn_capability(spawn_capability), explicit=bool(sandbox_policy))
    policy_name, dev_tools, _write_roots, _matched_root, policy = resolve_harness_sandbox(
        adapter.kind, model, cwd, explicit_policy=effective_policy)
    policy = apply_spawn_capability_to_policy(policy, spawn_capability, cwd)
    if adapter.kind in ("claude", "codex"):
        _require_native_tools(adapter.kind, policy_name, dev_tools)
    if adapter.kind == "claude":
        mode = _claude_permission_mode(policy_name, explicit_mode=mode)
    warning = adapter.warn_model(model)
    if warning:
        print(warning, file=sys.stderr)
    _check_fresh_name_available(name, server_up)
    if server_up:
        ws_register(
            fleet_id, name, sess, cwd, model, effort, refresh=True,
            kind=adapter.kind, spawn_capability=spawn_capability,
            metadata={**sandbox_metadata(policy), **spawn_policy_metadata(spawn_capability, policy_name)})

    cmd = adapter.build_cmd(fleet_id, sess, model, effort, mode, name=name, cwd=cwd,
                            capability=spawn_capability,
                            outer_sandbox=bool(policy))
    if policy:
        cmd = wrap_sandbox_cmd(cmd, policy)
    if adapter.kind == "codex":
        ensure_codex_project_trusted(cwd)
    spawn_tmux(sess, cwd, cmd, send_keys=adapter.spawn_send_keys())
    if adapter.kind == "codex":
        inject_codex_prompt(sess, codex_register_prompt(name))
    suffix = "" if adapter.kind == "claude" else f" ({adapter.kind})"
    print(f"{sess} ({fleet_id}) spawned in {cwd}{suffix}")
    return sess


def respawn(name, model, cwd, effort, mode, session_override=None,
            spawn_capability_override=None,
            sandbox_policy=None):
    ensure_server()
    agent = find_agent(name)
    if not agent:
        print(f"Error: No agent '{name}'. Use --fresh to create.", file=sys.stderr)
        sys.exit(1)

    fleet_id = agent["id"]
    meta = agent_meta(agent)
    cwd = cwd or agent.get("cwd") or os.getcwd()
    raw_model = model or meta.get("model")
    spawn_policy = meta.get("spawnPolicy") if isinstance(meta, dict) else None
    spawn_capability = spawn_capability_override or (spawn_policy.get("capability") if isinstance(spawn_policy, dict) else None) or DEFAULT_SPAWN_CAPABILITY
    spawn_policy_name = spawn_policy.get("policy") if isinstance(spawn_policy, dict) else None
    adapter = harness_for_agent(agent, raw_model)
    model = adapter.resolve_model(raw_model)
    # explicit = ONLY a command-line --policy (sandbox_policy). A STORED
    # spawn_policy_name from the agent's metadata must NOT count as explicit:
    # otherwise an agent that once got `cwd` metadata (e.g. spawned during a
    # fence-on window) gets re-fenced on every respawn even though the fence is
    # globally OFF -- which silently breaks the agent's job. With the fence off
    # (FENCE_GLOBALLY_DISABLED), nothing is fenced unless a human passes --policy
    # for a deliberate manual test. (When the fence is on, the resolved policy
    # below still honors the stored policy; only the global-off bypass is gated.)
    effective_policy = _live_spawn_policy(sandbox_policy or spawn_policy_name or sandbox_policy_for_spawn_capability(spawn_capability), explicit=bool(sandbox_policy))
    policy_name, dev_tools, _write_roots, _matched_root, policy = resolve_harness_sandbox(
        adapter.kind, model, cwd, explicit_policy=effective_policy)
    policy = apply_spawn_capability_to_policy(policy, spawn_capability, cwd)
    if adapter.kind in ("claude", "codex"):
        _require_native_tools(adapter.kind, policy_name, dev_tools)
    if adapter.kind == "claude":
        mode = _claude_permission_mode(policy_name, explicit_mode=mode)
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
        if _session_has_runtime(sess):
            return sess

    handle = adapter.find_resume(agent, session_override)
    if not handle and session_override:
        print(f"Error: No {adapter.kind} resume handle {session_override} for {name} ({fleet_id}). Use --refresh to start fresh.", file=sys.stderr)
        sys.exit(1)
    if not handle and adapter.resume_not_found_is_error():
        print(f"Error: {adapter.no_resume_message()} for {name} ({fleet_id}). Use --refresh to start fresh.", file=sys.stderr)
        sys.exit(1)

    resume_id = adapter.resume_id(handle)
    cwd = adapter.adjust_resume_cwd(cwd, handle or {})

    if adapter.kind == "claude" and resume_id:
        # NEVER fall back to --refresh here. --refresh spawns an imposter agent
        # with no real context. If --resume is stuck in a death loop, let it fail
        # visibly so someone can diagnose — don't silently replace the agent.
        strip_synthetic_tail(resume_id)

    cmd = adapter.build_cmd(
        fleet_id, sess, model, effort, mode, resume_id=resume_id,
        include_prompt=(adapter.kind != "claude" or not resume_id), name=name, cwd=cwd,
        capability=spawn_capability,
        outer_sandbox=bool(policy))
    if policy:
        cmd = wrap_sandbox_cmd(cmd, policy)
    if adapter.kind == "codex":
        ensure_codex_project_trusted(cwd)
    if adapter.kind == "codex" and resume_id:
        ws_register(
            fleet_id, name, sess, cwd, model, effort,
            kind=adapter.kind, session_id=resume_id,
            metadata={**sandbox_metadata(policy), **spawn_policy_metadata(spawn_capability, policy_name)})
    started = spawn_tmux(
        sess, cwd, cmd, auto_dismiss=adapter.respawn_auto_dismiss(),
        send_keys=adapter.spawn_send_keys())
    if not started:
        print(f"{sess} ({fleet_id}) already alive — left running", file=sys.stderr)
        return sess
    if resume_id:
        adapter.after_resume_started(sess, name, resume_id)
        noun = "codex rollout" if adapter.kind == "codex" else "session"
        print(f"{sess} ({fleet_id}) resumed {noun} {resume_id}")
    else:
        print(f"{sess} ({fleet_id}) relaunched ({adapter.kind}, {adapter.no_resume_message()})")
    if adapter.kind == "codex":
        inject_codex_prompt(sess, codex_register_prompt(name))
    return sess


def refresh(name, model, cwd, effort, mode, spawn_capability=None,
            sandbox_policy=None):
    ensure_server()
    agent = find_agent(name)
    if not agent:
        print(f"Error: No agent '{name}'. Use --fresh to create.", file=sys.stderr)
        sys.exit(1)

    fleet_id = agent["id"]
    meta = agent_meta(agent)
    cwd = cwd or agent.get("cwd") or os.getcwd()
    raw_model = model or meta.get("model")
    adapter = harness_for_agent(agent, raw_model)
    model = adapter.resolve_model(raw_model)
    effective_policy = _live_spawn_policy(sandbox_policy or sandbox_policy_for_spawn_capability(spawn_capability), explicit=bool(sandbox_policy))
    policy_name, dev_tools, _write_roots, _matched_root, policy = resolve_harness_sandbox(
        adapter.kind, model, cwd, explicit_policy=effective_policy)
    policy = apply_spawn_capability_to_policy(policy, spawn_capability, cwd)
    if adapter.kind in ("claude", "codex"):
        _require_native_tools(adapter.kind, policy_name, dev_tools)
    if adapter.kind == "claude":
        mode = _claude_permission_mode(policy_name, explicit_mode=mode)
    if not effort:
        effort = meta.get("effort")
    sess = agent.get("tmux_session") or f"fleet-{name}"

    ws_register(
        fleet_id, name, sess, cwd, model, effort, refresh=True,
        kind=adapter.kind, spawn_capability=spawn_capability,
        metadata={**sandbox_metadata(policy), **spawn_policy_metadata(spawn_capability, policy_name)})
    cmd = adapter.build_cmd(fleet_id, sess, model, effort, mode, name=name, cwd=cwd,
                            capability=spawn_capability,
                            outer_sandbox=bool(policy))
    if policy:
        cmd = wrap_sandbox_cmd(cmd, policy)
    if adapter.kind == "codex":
        ensure_codex_project_trusted(cwd)
    spawn_tmux(sess, cwd, cmd, send_keys=adapter.spawn_send_keys())
    if adapter.kind == "codex":
        inject_codex_prompt(sess, codex_register_prompt(name))
    print(f"{sess} ({fleet_id}) refreshed in {cwd}")
    return sess


def _respawn_codex_session(rollout_id, fpath, name_override, model, cwd,
                           effort, enroll, dry_run):
    """Resume (or enroll) a codex agent by rollout id — the codex --session path.

    Parallels the Claude flow in respawn_session but reads identity from the
    codex rollout and launches via build_codex_cmd(resume_id=…). model is passed
    through verbatim (codex picks its subscription default when None) — never
    Claude-resolved."""
    own_id, agent_name, meta = _scan_codex_rollout_identity(fpath)

    if enroll and own_id:
        print(f"Error: Rollout already has {own_id}. Drop --enroll.", file=sys.stderr)
        sys.exit(1)
    if not own_id and not enroll:
        print(f"Error: No fleet ID in codex rollout {rollout_id}", file=sys.stderr)
        sys.exit(1)

    if not cwd:
        cwd = meta.get("cwd") or os.getcwd()

    if enroll and not own_id:
        ensure_server()
        own_id = f"fleet:{uuid.uuid4().hex[:8]}"
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

    agent_name = name_override or agent_name or own_id.replace("fleet:", "agent-")
    sess = f"fleet-{sanitize_session_name(agent_name)}"

    if dry_run:
        print(f"[dry-run] {sess} ({own_id}) — codex rollout {rollout_id}, cwd {cwd}")
        return sess

    ensure_server()
    ws_register(own_id, agent_name, sess, cwd, model, effort,
                kind="codex", session_id=rollout_id)
    cmd = build_codex_cmd(own_id, sess, model=model, resume_id=rollout_id,
                          name=agent_name, cwd=cwd)
    ensure_codex_project_trusted(cwd)
    spawn_tmux(sess, cwd, cmd, send_keys=HARNESS_ADAPTERS["codex"].spawn_send_keys())
    inject_codex_prompt(sess, codex_register_prompt(agent_name))
    action = "enrolled" if enroll else "resumed"
    print(f"{sess} ({own_id}) {action} codex rollout {rollout_id} in {cwd}")
    return sess


def respawn_session(session_uuid, name_override, model, cwd, effort, mode,
                    enroll=False, dry_run=False):
    """Respawn by session UUID — scans the transcript for fleet identity.

    Claude sessions live in ~/.claude/projects/*.jsonl; codex rollouts live in
    ~/.codex/sessions/**/rollout-*-<uuid>.jsonl. We dispatch on which one the id
    resolves to so `--session`/`--enroll` work for codex agents too."""
    import glob as globmod
    import re

    # Codex agents store rollouts under ~/.codex/sessions (not ~/.claude/projects).
    # If this id resolves to a codex rollout, resume that with context.
    codex_rollout = _codex_rollout_path(session_uuid)
    if codex_rollout:
        return _respawn_codex_session(session_uuid, codex_rollout, name_override,
                                      model, cwd, effort, enroll, dry_run)

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
    parser.add_argument("--spawn-capability", default=None)
    parser.add_argument("--policy", default=None,
                        choices=sorted(SANDBOX_POLICIES),
                        help="Harness-agnostic native-tools sandbox policy")
    parser.add_argument("--kind", default="claude", choices=sorted(HARNESS_ADAPTERS),
                        help="Agent runtime/harness (default: claude). Goose can also "
                             "be selected by its model aliases for compatibility.")
    parser.add_argument("--session", default=None)
    parser.add_argument("--enroll", action="store_true")
    parser.add_argument("--no-attach", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--list-models", action="store_true",
                        help="Print all spawnable model aliases (Claude + goose) + verified ids as JSON and exit")
    parser.add_argument("--_dismiss-devch", default=None, help=argparse.SUPPRESS)
    args = parser.parse_args()

    # Single source of truth for the UI's model autocomplete/validation: dump
    # every spawnable alias, its resolved id, and whether it's verified. The
    # server serves this so the spawn UI never drifts from what fleet-spawn
    # actually accepts — both families, so the UI derives its WHOLE model pool
    # from here rather than re-listing aliases. `kind` lets the UI group/badge;
    # Claude aliases are always tool-capable, so verified; goose aliases are
    # verified per the probe. `default` stays the goose default.
    if args.list_models:
        models = []
        for adapter in HARNESS_ADAPTERS.values():
            models.extend(adapter.list_models())
        print(json.dumps({
            "default": GOOSE_MODELS.get("deepseek"),
            "models": models,
            "verified": sorted(GOOSE_VERIFIED),
        }, indent=2))
        return

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
        default_capability = args.spawn_capability or DEFAULT_SPAWN_CAPABILITY
        if args.dry_run and not (args.session and (not args.name or args.enroll)):
            action = "fresh spawn" if args.fresh else ("refresh" if args.refresh else "respawn")
            name = args.name or args.session
            print(f"[dry-run] would {action} {name} with capability {default_capability}")
            return
        if args.session and (not args.name or args.enroll):
            sess = respawn_session(args.session, args.name, args.model, args.cwd,
                                   args.effort, mode, args.enroll, args.dry_run)
        elif args.fresh:
            sess = fresh(args.name, args.model, args.cwd, args.effort, mode,
                         kind=args.kind, spawn_capability=default_capability,
                         sandbox_policy=args.policy)
        elif args.refresh:
            sess = refresh(args.name, args.model, args.cwd, args.effort, mode,
                           spawn_capability=default_capability,
                           sandbox_policy=args.policy)
        else:
            sess = respawn(args.name, args.model, args.cwd, args.effort, mode,
                           args.session,
                           spawn_capability_override=args.spawn_capability,
                           sandbox_policy=args.policy)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(2)

    if not args.no_attach and not args.dry_run:
        cmd = tmux("attach-session", "-t", sess)
        os.execvp(cmd[0], cmd)


if __name__ == "__main__":
    main()
