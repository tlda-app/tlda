#!/usr/bin/env python3
"""fleet-spawn — spawn or respawn fleet agents.

Usage:
  fleet-spawn <friendlyname>            Respawn existing agent (resume most recent session)
  fleet-spawn --fresh <friendlyname>    Spawn a brand new agent

Options:
  --model <model>    Override model (default: sonnet, or agent's stored model)
  --cwd <path>       Override working directory (fresh mode only)
  --no-attach        Don't attach to the tmux session after spawning
  --help             Show this help
"""

import argparse
import json
import os
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
DEFAULT_MODEL = 'claude-sonnet-4-6'

# Model aliases — "opus" gets the 1M context variant
def resolve_model(model):
    if model == "opus":
        return "claude-opus-4-6[1m]"
    if model == "sonnet":
        return "claude-sonnet-4-6"
    return model

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)
TLDA_CLI = os.path.join(REPO_DIR, "cli", "tlda.mjs")


def ensure_server():
    """Try to start the fleet server if it's not running. Returns True if up, False if not."""
    try:
        urlopen(f"{API}/api/state", timeout=2)
        return True
    except URLError:
        pass

    if DASH_HOST not in ("127.0.0.1", "localhost"):
        print(f"Warning: tlda server unreachable at {API}", file=sys.stderr)
        return False

    print(f"tlda server not running — starting...", file=sys.stderr)
    subprocess.run(["node", TLDA_CLI, "server", "start"], cwd=REPO_DIR,
                    capture_output=True, timeout=15)

    for _ in range(20):
        time.sleep(0.5)
        try:
            urlopen(f"{API}/api/state", timeout=1)
            print("tlda server started.", file=sys.stderr)
            return True
        except URLError:
            pass

    print("Error: tlda server failed to start.", file=sys.stderr)
    return False


def ws_register(fleet_id, name, tmux_session, cwd, model=None):
    """Pre-register agent via WS so it appears in the panel before Claude starts."""
    ws_url = f"ws://{DASH_HOST}:{DASH_PORT}/ws/fleet?agent={fleet_id}"
    try:
        ws = websocket.create_connection(ws_url, timeout=3)
        msg = {"type": "register", "id": fleet_id, "name": name,
               "tmux_session": tmux_session, "cwd": cwd}
        if model:
            msg["metadata"] = {"model": model}
        ws.send(json.dumps(msg))
        ws.close()
    except Exception as e:
        print(f"[fleet-spawn] pre-register WS failed (non-fatal): {e}", file=sys.stderr)


def api_get(path):
    try:
        return json.loads(urlopen(f"{API}{path}", timeout=5).read())
    except URLError as e:
        print(f"Error: fleet server unreachable at {API} — {e}", file=sys.stderr)
        sys.exit(1)


def api_post(path, data):
    req = Request(f"{API}{path}", data=json.dumps(data).encode(), headers={"Content-Type": "application/json"})
    try:
        return json.loads(urlopen(req, timeout=5).read())
    except URLError as e:
        print(f"Error: fleet server unreachable at {API} — {e}", file=sys.stderr)
        sys.exit(1)


def tmux_kill(session):
    subprocess.run(["tmux", "kill-session", "-t", session], capture_output=True)


def tmux_start(session, cwd, cmd):
    subprocess.run(["tmux", "new-session", "-d", "-s", session, "-c", cwd, cmd], check=True)
    # Auto-accept channels dialog, then tell the agent to register with fleet.
    subprocess.Popen(
        f"sleep 3 && tmux send-keys -t {session} Enter && sleep 5 && tmux send-keys -t {session} Enter && sleep 8 && tmux send-keys -t {session} 'Call register() with the fleet MCP server. Then call my_task() to check for a pending task.' Enter",
        shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def fresh_spawn(name, model, cwd):
    server_up = ensure_server()
    fleet_id = f"fleet:{uuid.uuid4().hex[:8]}"
    sess = f"fleet-{name}"
    cwd = cwd or os.getcwd()
    model = resolve_model(model or DEFAULT_MODEL)

    if server_up:
        agents = api_get("/api/store/agents")
        existing = [a for a in agents if a.get("friendly_name") == name]
        if existing:
            print(f"Error: agent '{name}' already exists ({existing[0]['id']}). "
                  f"Use respawn: fleet-spawn {name}", file=sys.stderr)
            sys.exit(1)
        ws_register(fleet_id, name, sess, cwd, model)

    tmux_kill(sess)

    cmd = f"FLEET_ID={fleet_id} claude --dangerously-load-development-channels server:fleet --model '{model}'"
    tmux_start(sess, cwd, cmd)

    if server_up:
        print(f"{sess} ({fleet_id}) spawned in {cwd}")
    else:
        print(f"{sess} ({fleet_id}) spawned in {cwd} (server down — will register on reconnect)")
    return sess


def derive_project_hash(cwd):
    """Derive the Claude Code project hash from a cwd path.
    Claude replaces / with - (the leading / becomes the leading -)."""
    return cwd.replace("/", "-")


def find_sessions_for_agent(fleet_id, cwd):
    """Scan JSONLs in the Claude project dir for ones where this fleet_id
    was the LAST agent to register. Uses structural matching (toolUseResult
    containing 'Registered fleet:XXXX as agent') rather than raw string grep,
    so mentions of the fleet ID in chat/logs don't cause false matches.
    Returns list of (session_id, mtime, fpath) sorted by mtime descending."""
    import json, re
    project_hash = derive_project_hash(cwd)
    project_dir = os.path.expanduser(f"~/.claude/projects/{project_hash}")
    if not os.path.isdir(project_dir):
        return []

    register_pattern = re.compile(r'Registered (fleet:\w+)')
    results = []
    for fname in os.listdir(project_dir):
        if not fname.endswith(".jsonl"):
            continue
        fpath = os.path.join(project_dir, fname)
        session_id = fname[:-6]  # strip .jsonl
        try:
            mtime = os.path.getmtime(fpath)
        except OSError:
            continue
        # Parse JSONL entries looking for register() tool results.
        # Track the last fleet ID that registered in this session.
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
            results.append((session_id, mtime, fpath))

    results.sort(key=lambda x: x[1], reverse=True)
    return results


def respawn(name, model_override, cwd_override, session_override=None):
    server_up = ensure_server()

    if not server_up:
        print(f"Error: fleet server is down — can't look up agent '{name}' to respawn.", file=sys.stderr)
        print(f"Start the server first (tlda server start), or use --fresh to create a new agent.", file=sys.stderr)
        sys.exit(1)

    agents = api_get("/api/store/agents")
    agent = next((a for a in agents if a.get("friendly_name") == name), None)
    if not agent:
        print(f"Error: No agent named '{name}' found.")
        print(f"Use --fresh to create a new agent: fleet-spawn --fresh {name}")
        sys.exit(1)

    fleet_id = agent["id"]
    cwd = cwd_override or agent.get("cwd") or os.getcwd()
    meta = agent.get("metadata") or {}
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except Exception:
            meta = {}
    model = resolve_model(model_override or (meta.get("model") if isinstance(meta, dict) else None) or DEFAULT_MODEL)
    sess = agent.get("tmux_session") or f"fleet-{name}"

    # Find the most recent session by scanning JSONLs for this agent's fleet_id.
    # This is the source of truth — not the DB's session_id field.
    sessions = find_sessions_for_agent(fleet_id, cwd)

    if session_override:
        resume_id = session_override
    else:
        resume_id = sessions[0][0] if sessions else None

    if not resume_id:
        # No session to resume — spawn fresh with the existing fleet ID.
        print(f"No resumable session for {name} ({fleet_id}) — spawning fresh.", file=sys.stderr)
        tmux_kill(sess)
        if server_up:
            ws_register(fleet_id, name, sess, cwd, model)
        cmd = f"FLEET_ID={fleet_id} claude --dangerously-load-development-channels server:fleet --model '{model}'"
        tmux_start(sess, cwd, cmd)
        print(f"{sess} ({fleet_id}) spawned fresh in {cwd}")
        return sess

    tmux_kill(sess)

    cmd = f"FLEET_ID={fleet_id} claude --dangerously-load-development-channels server:fleet --resume {resume_id}"
    cmd += f" --model '{model}'"
    tmux_start(sess, cwd, cmd)

    # Verify Claude actually started (didn't exit with "no conversation found")
    time.sleep(2)
    result = subprocess.run(["tmux", "has-session", "-t", sess], capture_output=True)
    if result.returncode != 0:
        # Session died — Claude couldn't resume. Show alternatives.
        print(f"Error: Claude could not resume session {resume_id}.", file=sys.stderr)
        if len(sessions) > 1:
            print(f"\nOther sessions for {name} ({fleet_id}):", file=sys.stderr)
            for sid, mtime, fpath in sessions[1:]:
                ts = time.strftime("%b %d, %I:%M %p", time.localtime(mtime))
                print(f"  {sid}  ({ts})", file=sys.stderr)
            print(f"\nUse: fleet-spawn {name} --session <id>", file=sys.stderr)
        print(f"Or:  fleet-spawn --fresh {name}", file=sys.stderr)
        sys.exit(1)

    print(f"{sess} ({fleet_id}) resumed session {resume_id}")
    return sess


def main():
    parser = argparse.ArgumentParser(description="Spawn or respawn fleet agents")
    parser.add_argument("name", help="Agent friendly name")
    parser.add_argument("--fresh", action="store_true", help="Spawn a new agent instead of respawning")
    parser.add_argument("--model", default=None, help="Override model (default: sonnet)")
    parser.add_argument("--cwd", default=None, help="Override working directory")
    parser.add_argument("--session", default=None, help="Resume a specific session ID (skip auto-detection)")
    parser.add_argument("--no-attach", action="store_true", help="Don't attach to tmux session after spawning")
    args = parser.parse_args()

    if args.fresh:
        sess = fresh_spawn(args.name, args.model, args.cwd)
    else:
        sess = respawn(args.name, args.model, args.cwd, args.session)

    if not args.no_attach:
        os.execvp("tmux", ["tmux", "attach-session", "-t", sess])


if __name__ == "__main__":
    main()
