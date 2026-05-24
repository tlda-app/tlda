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


def ws_register(fleet_id, name, tmux_session, cwd, model=None, effort=None):
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
        if meta:
            msg["metadata"] = meta
        ws.send(json.dumps(msg))
        ws.close()
    except Exception as e:
        print(f"[fleet-spawn] pre-register failed (non-fatal): {e}", file=sys.stderr)


# ---- Agent lookup ----

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
                     resume_id=None):
    """Build the shell command string for claude inside tmux.

    Passes REGISTER_PROMPT as a positional arg so the agent has work
    immediately (fixes death loop where --resume exits "No response
    requested" when last JSONL turn was assistant).

    Passes FLEET_TMUX_SESSION so register() uses the correct session name
    instead of auto-detecting (fixes identity corruption in recycled sessions).
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
    parts.append(shlex.quote(REGISTER_PROMPT))
    return " ".join(parts)


def spawn_tmux(session, cwd, cmd):
    """Start a tmux session running cmd. Backgrounds a process to dismiss
    the dev-channels confirmation dialog (sends '1' + Enter after 3s)."""
    subprocess.run(tmux("new-session", "-d", "-s", session, "-c", cwd, cmd), check=True)
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
        ws_register(fleet_id, name, sess, cwd, model, effort)

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
        return sess

    resume_id = session_override or agent.get("session_id")
    if not resume_id:
        print(f"No session for {name} — spawning fresh with existing ID.", file=sys.stderr)
        ws_register(fleet_id, name, sess, cwd, model, effort)
        cmd = build_claude_cmd(fleet_id, sess, model, effort, mode)
        spawn_tmux(sess, cwd, cmd)
        print(f"{sess} ({fleet_id}) spawned fresh in {cwd}")
        return sess

    cmd = build_claude_cmd(fleet_id, sess, model, effort, mode, resume_id=resume_id)
    spawn_tmux(sess, cwd, cmd)
    verify_session(sess, f"session {resume_id}")
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

    ws_register(fleet_id, name, sess, cwd, model, effort)
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
