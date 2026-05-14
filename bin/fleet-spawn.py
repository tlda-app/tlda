#!/usr/bin/env python3
"""fleet-spawn — spawn or respawn fleet agents.

Usage:
  fleet-spawn <friendlyname>                   Respawn existing agent (resume most recent session)
  fleet-spawn --fresh <friendlyname>           Spawn a brand new agent
  fleet-spawn --session <uuid>                 Respawn by session UUID (no name needed)

Options:
  --model <model>    Override model (default: sonnet, or agent's stored model)
  --cwd <path>       Override working directory (fresh mode only)
  --effort <level>   Effort level: low|medium|high|xhigh|max (default: inherit global config)
  --no-attach        Don't attach to the tmux session after spawning
  --dry-run          Print what would happen without spawning
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

TLDA_CONFIG_FILE = os.path.join(os.path.expanduser("~"), ".config", "tlda", "config.json")

def read_tlda_config():
    try:
        with open(TLDA_CONFIG_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def _tmux_socket():
    return read_tlda_config().get("tmuxSocket") or None

def tmux_cmd(*args):
    """Build a tmux command list with the configured socket (-L <socket>) if set."""
    sock = _tmux_socket()
    return ["tmux", "-L", sock, *args] if sock else ["tmux", *args]

# Model aliases — agents pass these short names; we resolve to Claude Code model IDs.
MODEL_ALIASES = {
    "opus": "claude-opus-4-6[1m]",      # default opus — 4.6 burns less context than 4.7
    "opus46": "claude-opus-4-6[1m]",    # explicit
    "opus47": "claude-opus-4-7[1m]",    # opt-in for the latest opus
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5",
}

def resolve_model(model):
    if model in MODEL_ALIASES:
        return MODEL_ALIASES[model]
    # Literal Claude Code model IDs pass through unchanged.
    if model.startswith("claude-"):
        return model
    valid = ", ".join(sorted(MODEL_ALIASES.keys()))
    raise ValueError(
        f"Unknown model: {model!r}. "
        f"Valid aliases: {valid}. "
        f"Or pass a literal claude-* model ID."
    )

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


def ws_register(fleet_id, name, tmux_session, cwd, model=None, effort=None):
    """Pre-register agent via WS so it appears in the panel before Claude starts."""
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
    subprocess.run(tmux_cmd("kill-session", "-t", session), capture_output=True)


REGISTER_PROMPT = "Call register() with the fleet MCP server. Then call my_task() to check for a pending task."

# Glyphs whose presence in the tail of a Claude Code pane indicates the agent
# is busy (spinner running, /compact in progress, prompt input not yet active).
# Sending keystrokes while these are showing tends to land in the void —
# the Enter doesn't submit because the input field isn't focused yet.
BUSY_INDICATORS = ("✻", "⏺ ", "Compacting", "esc to interrupt")


def pane_idle(session):
    """True if the agent's tmux pane shows the input prompt (`❯`) with no
    active spinner / compaction line in the input area or status row.

    Claude Code renders the input area as a box bounded by two `────────`
    dividers, with a status row below the bottom divider:

        ────────  ← top divider (penultimate)
        ❯ <prompt text>
        ────────  ← bottom divider (last)
          esc to interrupt · ...        (busy)
          ? for shortcuts               (idle)

    A finished `✻ Brewed for Ns` line that scrolled into the history
    above the top divider isn't "busy" — only spinners/compact lines
    *inside* the box, or "esc to interrupt" in the status row, count.
    """
    out = subprocess.run(
        tmux_cmd("capture-pane", "-t", session, "-p", "-S", "-30"),
        capture_output=True, text=True, check=False,
    ).stdout or ""
    lines = out.splitlines()
    # Find indices of the last two divider lines.
    dividers = [i for i, l in enumerate(lines) if l.startswith("────")]
    if len(dividers) >= 2:
        # Input area is between the last two dividers; status row is after.
        check = "\n".join(lines[dividers[-2]:])
    else:
        # Fall back to the bottom of the pane if the layout doesn't match.
        check = "\n".join(lines[-6:])
    if any(g in check for g in BUSY_INDICATORS):
        return False
    return "❯" in check


CHANNELS_DIALOG_MARKER = "Loading development channels"


def pane_has_channels_dialog(session):
    """True if the agent's tmux pane is currently showing the
    `--dangerously-load-development-channels` confirmation dialog."""
    out = subprocess.run(
        tmux_cmd("capture-pane", "-t", session, "-p", "-S", "-50"),
        capture_output=True, text=True, check=False,
    ).stdout or ""
    return CHANNELS_DIALOG_MARKER in out and "I am using this for local development" in out


def dismiss_channels_dialog(session):
    """Send '1\\n' to select 'I am using this for local development' and
    confirm. Idempotent if the dialog isn't there (a stray '1' lands in
    the input area but Enter clears it on a non-prompt screen)."""
    subprocess.run(tmux_cmd("send-keys", "-t", session, "1"), check=False)
    subprocess.run(tmux_cmd("send-keys", "-t", session, "Enter"), check=False)


def inject_register_prompt(session, deadline_seconds=120):
    """Wait for the agent to reach an idle input prompt, then type the
    register prompt and submit. Detects and dismisses the dev-channels
    confirmation dialog as it appears (timing varies — CC startup can be
    slow on a thrashed machine, so we poll instead of firing one Enter
    at a fixed delay). Used as the entry point for the --inject-keystrokes
    child process that tmux_start backgrounds."""
    deadline = time.time() + deadline_seconds
    dismissed = False
    # Initial settle so the tmux pane has rendered something.
    time.sleep(2)
    while time.time() < deadline:
        if not dismissed and pane_has_channels_dialog(session):
            dismiss_channels_dialog(session)
            dismissed = True
            # Give CC a moment to process and re-render past the dialog.
            time.sleep(2)
            continue
        if pane_idle(session):
            break
        time.sleep(1.5)
    else:
        # Timed out — agent never reached idle. Don't force-inject; better
        # to leave the session alone than to scribble into a busy buffer.
        return

    # send-keys -l treats the arg as literal so quotes/backticks don't expand.
    subprocess.run(tmux_cmd("send-keys", "-t", session, "-l", REGISTER_PROMPT), check=False)
    subprocess.run(tmux_cmd("send-keys", "-t", session, "Enter"), check=False)


def tmux_start(session, cwd, cmd):
    """Start a new tmux session and background a child that injects the
    register prompt once the agent reaches its prompt. Pane-state-aware so
    the keystrokes don't get swallowed by an in-progress /compact or
    thinking spinner on resume."""
    subprocess.run(tmux_cmd("new-session", "-d", "-s", session, "-c", cwd, cmd), check=True)
    # Re-invoke this script with --inject-keystrokes <session>; the child
    # runs inject_register_prompt() and exits. Using sys.executable + the
    # script path keeps the helper readable and testable in isolation.
    subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "--inject-keystrokes", session],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def fresh_spawn(name, model, cwd, effort=None, mode=None):
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
        ws_register(fleet_id, name, sess, cwd, model, effort)

    tmux_kill(sess)

    cmd = f"FLEET_ID={fleet_id} claude --dangerously-load-development-channels server:fleet --model '{model}'"
    if effort:
        cmd += f" --effort '{effort}'"
    if mode:
        cmd += f" --permission-mode '{mode}'"
    tmux_start(sess, cwd, cmd)

    if server_up:
        print(f"{sess} ({fleet_id}) spawned in {cwd}")
    else:
        print(f"{sess} ({fleet_id}) spawned in {cwd} (server down — will register on reconnect)")
    return sess


def find_sessions_for_agent(fleet_id, session_id_hint=None):
    """Find JSONL files for this agent.
    Fast path: search ~/.claude/projects/*/<session_id_hint>.jsonl by filename —
    no file reading, just directory listings across ~50 project dirs.
    Fallback: scan all JSONL contents for ones where fleet_id was the last to register.
    Returns list of (session_id, mtime, fpath) sorted by mtime descending."""
    import glob as globmod, json, re
    projects_base = os.path.expanduser("~/.claude/projects")

    # Fast path: search by known session_id (from DB's session_id field)
    if session_id_hint:
        matches = globmod.glob(os.path.join(projects_base, "*", f"{session_id_hint}.jsonl"))
        if matches:
            results = []
            for fpath in matches:
                try:
                    mtime = os.path.getmtime(fpath)
                    results.append((session_id_hint, mtime, fpath))
                except OSError:
                    continue
            if results:
                results.sort(key=lambda x: x[1], reverse=True)
                return results

    # Fallback: content scan across all project dirs
    if not os.path.isdir(projects_base):
        return []
    register_pattern = re.compile(r'Registered (fleet:\w+)')
    results = []
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
                results.append((sid, mtime, fpath))
    results.sort(key=lambda x: x[1], reverse=True)
    return results


def respawn(name, model_override, cwd_override, session_override=None, effort=None, mode=None):
    server_up = ensure_server()

    if not server_up:
        print(f"Error: fleet server is down — can't look up agent '{name}' to respawn.", file=sys.stderr)
        print(f"Start the server first (tlda server start), or use --fresh to create a new agent.", file=sys.stderr)
        sys.exit(1)

    agents = api_get("/api/store/agents")
    # Accept either a friendly name or a fleet ID (e.g. "fleet:abc123") directly
    if name.startswith("fleet:"):
        agent = next((a for a in agents if a.get("id") == name), None)
    else:
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

    # Find JSONL: fast path uses session_id from DB, fallback does full content scan.
    sessions = find_sessions_for_agent(fleet_id, agent.get("session_id"))

    if session_override:
        resume_id = session_override
    else:
        resume_id = sessions[0][0] if sessions else None

    if not resume_id:
        # No session to resume — spawn fresh with the existing fleet ID.
        print(f"No resumable session for {name} ({fleet_id}) — spawning fresh.", file=sys.stderr)
        tmux_kill(sess)
        if server_up:
            ws_register(fleet_id, name, sess, cwd, model, effort)
        cmd = f"FLEET_ID={fleet_id} claude --dangerously-load-development-channels server:fleet --model '{model}'"
        if effort:
            cmd += f" --effort '{effort}'"
        if mode:
            cmd += f" --permission-mode '{mode}'"
        tmux_start(sess, cwd, cmd)
        print(f"{sess} ({fleet_id}) spawned fresh in {cwd}")
        return sess

    tmux_kill(sess)

    cmd = f"FLEET_ID={fleet_id} claude --dangerously-load-development-channels server:fleet --resume {resume_id}"
    cmd += f" --model '{model}'"
    if effort:
        cmd += f" --effort '{effort}'"
    if mode:
        cmd += f" --permission-mode '{mode}'"
    tmux_start(sess, cwd, cmd)

    # Verify Claude actually started (didn't exit with "no conversation found")
    time.sleep(2)
    result = subprocess.run(tmux_cmd("has-session", "-t", sess), capture_output=True)
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


def refresh_spawn(name, model_override, cwd_override, effort=None, mode=None):
    """Spawn a fresh session for an existing agent — same fleet ID, no --resume.
    Breaks the compaction loop: agent re-registers with a clean JSONL."""
    server_up = ensure_server()

    if not server_up:
        print(f"Error: fleet server is down — can't look up agent '{name}' to refresh.", file=sys.stderr)
        sys.exit(1)

    agents = api_get("/api/store/agents")
    if name.startswith("fleet:"):
        agent = next((a for a in agents if a.get("id") == name), None)
    else:
        agent = next((a for a in agents if a.get("friendly_name") == name), None)
    if not agent:
        print(f"Error: No agent named '{name}' found. Use --fresh to create a new agent.", file=sys.stderr)
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
    if not effort:
        effort = meta.get("effort") if isinstance(meta, dict) else None
    sess = agent.get("tmux_session") or f"fleet-{name}"

    tmux_kill(sess)
    ws_register(fleet_id, name, sess, cwd, model, effort)

    cmd = f"FLEET_ID={fleet_id} claude --dangerously-load-development-channels server:fleet --model '{model}'"
    if effort:
        cmd += f" --effort '{effort}'"
    if mode:
        cmd += f" --permission-mode '{mode}'"
    tmux_start(sess, cwd, cmd)

    print(f"{sess} ({fleet_id}) refreshed in {cwd}")
    return sess


def respawn_from_session(session_uuid, model_override, cwd_override, effort=None, mode=None, dry_run=False, enroll=False, enroll_name=None):
    """Respawn an agent given only a session UUID.
    Scans the JSONL to extract fleet ID and friendly name, then respawns.
    With enroll=True: if no registration exists, mints a new fleet ID for the session."""
    import glob as globmod, re

    projects_base = os.path.expanduser("~/.claude/projects")
    matches = globmod.glob(os.path.join(projects_base, "*", f"{session_uuid}.jsonl"))

    if not matches:
        print(f"Error: No JSONL found for session {session_uuid}", file=sys.stderr)
        sys.exit(1)

    fpath = matches[0]
    project_dir = os.path.basename(os.path.dirname(fpath))

    fleet_id = None
    name = None
    register_pattern = re.compile(r'Registered (fleet:\w+)')
    name_pattern = re.compile(r'Your name: "([^"]+)"')

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
                            fleet_id = m.group(1)
                            nm = name_pattern.search(text)
                            if nm:
                                name = nm.group(1)
                            break
                    if fleet_id:
                        break
                except (json.JSONDecodeError, AttributeError):
                    continue
    except OSError as e:
        print(f"Error: Could not read JSONL: {e}", file=sys.stderr)
        sys.exit(1)

    # --enroll guard: fail if JSONL already has a registration
    if enroll and fleet_id:
        print(f"Error: Session already has fleet ID {fleet_id} — use fleet-spawn --session {session_uuid} without --enroll.", file=sys.stderr)
        sys.exit(1)

    if not fleet_id and not enroll:
        print(f"Error: No fleet registration found in session {session_uuid}", file=sys.stderr)
        sys.exit(1)

    # Derive cwd from project dir name: "-Users-skip-work-tlda" → "/Users/skip/work/tlda"
    if cwd_override:
        cwd = cwd_override
    elif project_dir.startswith("-"):
        cwd = "/" + project_dir[1:].replace("-", "/")
    else:
        cwd = os.getcwd()

    # --enroll: mint a new fleet ID and derive a name from the cwd basename (or explicit override)
    if enroll and not fleet_id:
        server_up = ensure_server()
        fleet_id = f"fleet:{uuid.uuid4().hex[:8]}"

        if enroll_name:
            name = enroll_name
        else:
            # Auto-derive from cwd basename; add suffix if already taken
            base_name = os.path.basename(cwd.rstrip("/")) or "agent"
            name = base_name
            if server_up:
                existing_agents = api_get("/api/store/agents")
                existing_names = {a.get("friendly_name") for a in existing_agents}
                suffix = 2
                while name in existing_names:
                    name = f"{base_name}-{suffix}"
                    suffix += 1
        print(f"Enrolling new agent: {fleet_id} ({name}) — session {session_uuid}")
    else:
        if not name:
            name = fleet_id.replace("fleet:", "agent-")
        print(f"Found: {fleet_id} ({name}) — session {session_uuid}")

    model = resolve_model(model_override or DEFAULT_MODEL)
    sess = f"fleet-{name}"

    print(f"  cwd: {cwd}, model: {model}, tmux: {sess}")

    if dry_run:
        print("[dry-run] would spawn — exiting without spawning")
        return sess

    server_up = ensure_server()
    if server_up:
        ws_register(fleet_id, name, sess, cwd, model, effort)

    tmux_kill(sess)

    cmd = f"FLEET_ID={fleet_id} claude --dangerously-load-development-channels server:fleet --resume {session_uuid}"
    cmd += f" --model '{model}'"
    if effort:
        cmd += f" --effort '{effort}'"
    if mode:
        cmd += f" --permission-mode '{mode}'"
    tmux_start(sess, cwd, cmd)

    time.sleep(2)
    result = subprocess.run(tmux_cmd("has-session", "-t", sess), capture_output=True)
    if result.returncode != 0:
        print(f"Error: Claude could not resume session {session_uuid}.", file=sys.stderr)
        sys.exit(1)

    action = "enrolled and started" if enroll else "resumed"
    print(f"{sess} ({fleet_id}) {action} session {session_uuid} in {cwd}")
    return sess


def main():
    # The keystroke-injection child is invoked as a sub-process by
    # tmux_start; handle it before argparse so it doesn't conflict with
    # the normal CLI surface.
    if len(sys.argv) >= 3 and sys.argv[1] == "--inject-keystrokes":
        inject_register_prompt(sys.argv[2])
        return

    parser = argparse.ArgumentParser(description="Spawn or respawn fleet agents")
    parser.add_argument("name", nargs="?", default=None, help="Agent friendly name (optional if --session is given)")
    parser.add_argument("--fresh", action="store_true", help="Spawn a new agent instead of respawning")
    parser.add_argument("--refresh", action="store_true", help="Fresh session for existing agent (same fleet ID, breaks compaction loops)")
    parser.add_argument("--model", default=None, help="Override model (default: sonnet)")
    parser.add_argument("--cwd", default=None, help="Override working directory")
    parser.add_argument("--effort", default=None, help="Effort level: low|medium|high|xhigh|max")
    parser.add_argument("--mode", default=None, help="Permission mode passed to claude (e.g. plan, default, auto). Falls back to spawnMode in ~/.config/tlda/config.json")
    parser.add_argument("--session", default=None, help="Resume a specific session ID; if no name given, scans JSONL to find fleet ID and name")
    parser.add_argument("--enroll", action="store_true", help="With --session: mint a new fleet ID if none exists. Errors if session already has a fleet ID.")
    parser.add_argument("--no-attach", action="store_true", help="Don't attach to tmux session after spawning")
    parser.add_argument("--dry-run", action="store_true", help="Print what would happen without actually spawning")
    args = parser.parse_args()

    if args.name is None and not args.session:
        parser.print_usage(sys.stderr)
        print("Error: provide a name or --session <uuid>", file=sys.stderr)
        sys.exit(2)

    if args.enroll and not args.session:
        print("Error: --enroll requires --session <uuid>", file=sys.stderr)
        sys.exit(2)

    # Resolve mode: explicit flag > config file default
    mode = args.mode or read_tlda_config().get("spawnMode") or None

    try:
        if args.session and (args.name is None or args.enroll):
            # Nameless respawn, or enroll (name may be provided as override)
            sess = respawn_from_session(args.session, args.model, args.cwd, args.effort, mode, dry_run=args.dry_run, enroll=args.enroll, enroll_name=args.name)
        elif args.fresh:
            sess = fresh_spawn(args.name, args.model, args.cwd, args.effort, mode)
        elif args.refresh:
            sess = refresh_spawn(args.name, args.model, args.cwd, args.effort, mode)
        else:
            sess = respawn(args.name, args.model, args.cwd, args.session, args.effort, mode)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(2)

    if not args.no_attach and not getattr(args, 'dry_run', False):
        cmd = tmux_cmd("attach-session", "-t", sess)
        os.execvp(cmd[0], cmd)


if __name__ == "__main__":
    main()
