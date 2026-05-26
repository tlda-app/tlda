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
import os
import shlex
import subprocess
import sys
import time
import uuid
from urllib.request import urlopen, Request
from urllib.error import URLError
import websocket

DASH_PORT = os.environ.get("FLEET_DASH_PORT", "5176")
DASH_HOST = os.environ.get("FLEET_DASH_HOST", "127.0.0.1")
API = f"http://{DASH_HOST}:{DASH_PORT}"
DEFAULT_MODEL = "claude-opus-4-6[1m]"
REGISTER_PROMPT = "Call register() with the fleet MCP server. Then call my_task() to check for a pending task."

MODEL_ALIASES = {
    "opus": "claude-opus-4-6[1m]",
    "opus46": "claude-opus-4-6[1m]",
    "opus47": "claude-opus-4-7[1m]",
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5",
}

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
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


def resolve_model(model):
    if not model:
        return DEFAULT_MODEL
    if model in MODEL_ALIASES:
        return MODEL_ALIASES[model]
    if model.startswith("claude-"):
        return model
    raise ValueError(f"Unknown model: {model!r}. Valid: {', '.join(sorted(MODEL_ALIASES))}")


# ---- Server communication ----

def api_get(path):
    try:
        return json.loads(urlopen(f"{API}{path}", timeout=5).read())
    except URLError as e:
        print(f"Error: server unreachable at {API} — {e}", file=sys.stderr)
        sys.exit(1)


def ensure_server():
    try:
        urlopen(f"{API}/api/state", timeout=2)
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
            urlopen(f"{API}/api/state", timeout=1)
            print("Server started.", file=sys.stderr)
            return True
        except URLError:
            pass
    print("Error: server failed to start.", file=sys.stderr)
    return False


def ws_register(fleet_id, name, tmux_session, cwd, model=None, effort=None, refresh=False):
    ws_url = f"ws://{DASH_HOST}:{DASH_PORT}/ws/fleet?agent={fleet_id}"
    try:
        ws = websocket.create_connection(ws_url, timeout=3)
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
        ws.close()
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
    return next((a for a in agents if a.get("friendly_name") == name), None)


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
                     resume_id=None, include_prompt=True):
    """Build the shell command string for claude inside tmux.

    When include_prompt=True (fresh spawn, refresh), appends REGISTER_PROMPT
    as a positional arg. When False (resume), omits it so Claude Code stays
    in interactive mode — the caller injects the prompt via tmux send-keys.
    """
    parts = [f"FLEET_ID={fleet_id}", f"FLEET_TMUX_SESSION={tmux_session}", "claude"]
    if resume_id:
        parts.append(f"--resume {resume_id}")
    parts.append("--dangerously-load-development-channels server:fleet")
    parts.append(f"--model '{model}'")
    if effort:
        parts.append(f"--effort '{effort}'")
    if mode:
        parts.append(f"--permission-mode '{mode}'")
    if include_prompt:
        parts.append(shlex.quote(REGISTER_PROMPT))
    return " ".join(parts)



def _session_has_claude(session):
    """Check if a tmux session has a running claude process."""
    try:
        r = subprocess.run(tmux("list-panes", "-t", session, "-F", "#{pane_pid}"),
                           capture_output=True, text=True, timeout=5)
        if r.returncode != 0:
            return False
        for pid in r.stdout.strip().split():
            ps = subprocess.run(["ps", "-p", pid, "-o", "args="],
                                capture_output=True, text=True, timeout=5)
            if ps.returncode == 0 and "claude" in ps.stdout:
                return True
        return False
    except Exception:
        return False

def spawn_tmux(session, cwd, cmd, auto_dismiss=True):
    """Start a tmux session running cmd. When auto_dismiss=True, backgrounds
    a process to dismiss the dev-channels confirmation dialog."""
    # Try respawn-pane first — handles dead panes left by remain-on-exit.
    # Falls back to new-session when no session exists.
    r = subprocess.run(tmux("respawn-pane", "-t", session, "-c", cwd, cmd),
                       capture_output=True, timeout=5)
    if r.returncode != 0:
        subprocess.run(tmux("new-session", "-d", "-s", session, "-c", cwd, cmd), check=True)
        subprocess.run(tmux("set-option", "-t", session, "remain-on-exit", "on"),
                       capture_output=True, timeout=5)
    if auto_dismiss:
        subprocess.Popen(
            [sys.executable, "-c",
             f"import time,subprocess; time.sleep(3); "
             f"subprocess.run({tmux('send-keys', '-t', session, '1')!r}); "
             f"subprocess.run({tmux('send-keys', '-t', session, 'Enter')!r})"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )


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
            last = lines[-1] if lines else ''
            if '❯' in last and 'Enter to confirm' not in pane:
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
    sess = f"fleet-{name}"
    cwd = cwd or os.getcwd()
    model = resolve_model(model)

    if server_up:
        existing = find_agent(name)
        if existing:
            print(f"Error: '{name}' already exists ({existing['id']}). "
                  f"Use: fleet-spawn {name}", file=sys.stderr)
            sys.exit(1)
        ws_register(fleet_id, name, sess, cwd, model, effort, refresh=True)

    cmd = build_claude_cmd(fleet_id, sess, model, effort, mode)
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
    model = resolve_model(model or meta.get("model"))
    sess = agent.get("tmux_session") or f"fleet-{name}"

    if subprocess.run(tmux("has-session", "-t", sess), capture_output=True).returncode == 0:
        if _session_has_claude(sess):
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
                           resume_id=resume_id, include_prompt=False)
    spawn_tmux(sess, cwd, cmd, auto_dismiss=False)
    verify_session(sess, f"session {resume_id}")
    inject_prompt(sess, REGISTER_PROMPT)
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
    model = resolve_model(model or meta.get("model"))
    if not effort:
        effort = meta.get("effort")
    sess = agent.get("tmux_session") or f"fleet-{name}"

    ws_register(fleet_id, name, sess, cwd, model, effort, refresh=True)
    cmd = build_claude_cmd(fleet_id, sess, model, effort, mode)
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
    sess = f"fleet-{agent_name}"

    if dry_run:
        print(f"[dry-run] {sess} ({fleet_id}) — session {session_uuid}, cwd {cwd}")
        return sess

    ensure_server()
    ws_register(fleet_id, agent_name, sess, cwd, model, effort)
    cmd = build_claude_cmd(fleet_id, sess, model, effort, mode, resume_id=session_uuid)
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
    args = parser.parse_args()

    if not args.name and not args.session:
        parser.print_usage(sys.stderr)
        print("Error: provide a name or --session <uuid>", file=sys.stderr)
        sys.exit(2)
    if args.enroll and not args.session:
        print("Error: --enroll requires --session <uuid>", file=sys.stderr)
        sys.exit(2)

    mode = args.mode or read_config().get("spawnMode")

    try:
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
