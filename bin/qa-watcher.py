#!/usr/bin/env python3
"""
DeepSeek QA Agent — fleet agent that reviews writing agents' deliverables.

Watches agent→Skip messages. When an agent sends a substantial deliverable,
runs it through DeepSeek with a tool-use loop: reads the thread, reads files,
checks whether the output matches what Skip asked for.

Usage: python3 qa-watcher.py [agent1 agent2 ...]
  No args = watch all agents. Args = watch specific agents.

Environment:
  FLEET_ID            — this agent's fleet ID (set by fleet-spawn)
  FLEET_DASH_PORT     — fleet server port (default 5176)
  OPENROUTER_API_KEY  — OpenRouter API key
  DEEPSEEK_API_KEY    — DeepSeek direct key (fallback)
  QA_MODEL            — model to use (default: deepseek/deepseek-chat)
"""

import json, os, sys, time, urllib.request, threading, socket, base64, pathlib

FLEET_HOST = os.environ.get('FLEET_DASH_HOST', '127.0.0.1')
FLEET_PORT = os.environ.get('FLEET_DASH_PORT', '5176')
FLEET_API = f"http://{FLEET_HOST}:{FLEET_PORT}"
FLEET_ID = os.environ.get('FLEET_ID', 'fleet:deepseek-qa')
SKIP_ID = 'fleet:skip'

OPENROUTER_KEY = os.environ.get('OPENROUTER_API_KEY', '')
DEEPSEEK_KEY = os.environ.get('DEEPSEEK_API_KEY', '')
QA_MODEL = os.environ.get('QA_MODEL', 'deepseek/deepseek-chat')

if OPENROUTER_KEY:
    API_URL = "https://openrouter.ai/api/v1/chat/completions"
    API_KEY = OPENROUTER_KEY
elif DEEPSEEK_KEY:
    API_URL = "https://api.deepseek.com/chat/completions"
    API_KEY = DEEPSEEK_KEY
    QA_MODEL = "deepseek-chat"
else:
    API_URL = ""
    API_KEY = ""

ALLOWED_READ_ROOTS = [os.path.expanduser("~/work/")]

watched = set()

def log(msg):
    print(f"[qa] {msg}", file=sys.stderr, flush=True)

# ---- Fleet API helpers ----

def fleet_post(path, data):
    encoded = json.dumps(data).encode()
    req = urllib.request.Request(f"{FLEET_API}{path}", data=encoded,
        headers={"Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

def fleet_get(path):
    req = urllib.request.Request(f"{FLEET_API}{path}")
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

_ws_conn = None  # set by watch_ws

def fleet_chat(to, message):
    """Send chat via WS (persisted) or fall back to fleet-event (broadcast only)."""
    payload = {"type": "chat", "message": message, "to": to, "from": FLEET_ID}
    if _ws_conn:
        try:
            _ws_conn.send(json.dumps(payload))
            return {"ok": True}
        except Exception as e:
            log(f"WS chat failed: {e}")
    try:
        return fleet_post("/api/fleet-event", payload)
    except Exception as e:
        log(f"chat failed: {e}")
        return None

def ws_frame(payload):
    data = json.dumps(payload).encode()
    if len(data) < 126:
        return bytes([0x81, len(data)]) + data
    if len(data) < 65536:
        return bytes([0x81, 126]) + len(data).to_bytes(2, 'big') + data
    return bytes([0x81, 127]) + len(data).to_bytes(8, 'big') + data

def login_payload():
    return {
        "agent_id": FLEET_ID,
        "name": "qa-gate",
        "cwd": os.getcwd(),
        "machine_id": socket.gethostname().split('.')[0],
    }

def send_login(ws):
    payload = login_payload()
    ws.send(json.dumps({**payload, "type": "reserve-shell"}))
    ws.send(json.dumps({**payload, "type": "login"}))

def login():
    ws_url = f"ws://{FLEET_HOST}:{FLEET_PORT}/ws/fleet"
    payload = login_payload()
    try:
        import websocket as ws_mod
        ws = ws_mod.create_connection(ws_url, timeout=5)
        send_login(ws)
        try:
            resp = ws.recv()
            log(f"Logged in: {json.loads(resp).get('type', '?')}")
        except: pass
        ws.close()
    except ImportError:
        log("websocket-client not installed, using raw socket login")
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(5)
            s.connect((FLEET_HOST, int(FLEET_PORT)))
            key = base64.b64encode(os.urandom(16)).decode()
            handshake = (f"GET /ws/fleet HTTP/1.1\r\nHost: {FLEET_HOST}:{FLEET_PORT}\r\n"
                f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
            s.sendall(handshake.encode())
            resp = b""
            while b"\r\n\r\n" not in resp: resp += s.recv(4096)
            if b"101" in resp.split(b"\r\n")[0]:
                s.sendall(ws_frame({**payload, "type": "reserve-shell"}))
                s.sendall(ws_frame({**payload, "type": "login"}))
                time.sleep(0.5)
                log("Logged in via raw WS")
            s.close()
        except Exception as e:
            log(f"Login failed: {e}")

def get_all_agents():
    try:
        agents = fleet_get("/api/store/agents")
        return {a['id']: a.get('friendly_name', a['id']) for a in agents}
    except: return {}

def find_agent_id(query):
    agents = fleet_get("/api/store/agents")
    for a in agents:
        if a.get('id') == query or a.get('friendly_name') == query:
            return a['id'], a.get('friendly_name', a['id'])
    for a in agents:
        if query in a.get('id', '') or query in (a.get('friendly_name') or ''):
            return a['id'], a.get('friendly_name', a['id'])
    return None, None

# ---- Tool definitions (for DeepSeek function calling) ----

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file from the filesystem. Limited to ~/work/.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path to the file"},
                    "start_line": {"type": "integer", "description": "First line to read (1-indexed, optional)"},
                    "end_line": {"type": "integer", "description": "Last line to read (optional)"},
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_thread",
            "description": "Read the conversation thread for a specific agent. Returns messages between the agent and Skip.",
            "parameters": {
                "type": "object",
                "properties": {
                    "agent": {"type": "string", "description": "Agent name or fleet ID"},
                    "limit": {"type": "integer", "description": "Max messages to return (default 80)"},
                },
                "required": ["agent"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "chat",
            "description": "Send a message to an agent or to Skip via fleet chat.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {"type": "string", "description": "Recipient: agent name, fleet ID, or 'skip'"},
                    "message": {"type": "string", "description": "Message text (markdown supported)"},
                },
                "required": ["to", "message"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write a file to a project's scratch/ directory. Can only write to scratch/ directories under ~/work/.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to write. Must be under ~/work/*/scratch/"},
                    "content": {"type": "string", "description": "File content"},
                },
                "required": ["path", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "List files in a directory. Limited to ~/work/.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory path"},
                    "pattern": {"type": "string", "description": "Glob pattern filter (e.g. '*.tex')"},
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search",
            "description": "Search fleet chat logs for a keyword or phrase.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "limit": {"type": "integer", "description": "Max results (default 20)"},
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "viewing_context",
            "description": "Get Skip's current viewing position: which document, page, and source file/line he's looking at.",
            "parameters": {
                "type": "object",
                "properties": {},
            }
        }
    },
]

# ---- Tool implementations ----

def tool_read_file(path, start_line=None, end_line=None):
    resolved = str(pathlib.Path(path).expanduser().resolve())
    if not any(resolved.startswith(root) for root in ALLOWED_READ_ROOTS):
        return f"Error: path {path} is outside allowed roots ({', '.join(ALLOWED_READ_ROOTS)})"
    try:
        with open(resolved, 'r') as f:
            lines = f.readlines()
        total = len(lines)
        s = (start_line - 1) if start_line and start_line > 0 else 0
        e = end_line if end_line else min(s + 200, total)
        selected = lines[s:e]
        header = f"[{resolved} — {total} lines, showing {s+1}-{min(e, total)}]\n"
        return header + ''.join(f"{i+s+1}\t{l}" for i, l in enumerate(selected))
    except Exception as ex:
        return f"Error reading {path}: {ex}"

def tool_read_thread(agent, limit=80):
    aid, aname = find_agent_id(agent)
    if not aid:
        return f"Agent '{agent}' not found."
    events = fleet_get(f"/api/store/events?agent={aid}&limit={limit}").get("events", [])
    lines = []
    for e in events:
        f = e.get("from_id", "?")
        ts = e.get("timestamp", "")[:19]
        text = (e.get("text") or "")[:800]
        role = "[SKIP]" if "skip" in f.lower() else f"[{f}]"
        lines.append(f"{ts} {role}: {text}")
    return '\n'.join(lines) if lines else "No messages found."

def tool_chat(to, message):
    target = SKIP_ID if to.lower() == 'skip' else to
    if not target.startswith('fleet:'):
        aid, _ = find_agent_id(target)
        target = aid or target
    result = fleet_chat(target, message)
    return "Sent." if result else "Failed to send."

def tool_write_file(path, content):
    resolved = str(pathlib.Path(path).expanduser().resolve())
    if not any(resolved.startswith(root) for root in ALLOWED_READ_ROOTS):
        return f"Error: path outside allowed roots"
    if '/scratch/' not in resolved:
        return f"Error: can only write to scratch/ directories. Got: {path}"
    try:
        os.makedirs(os.path.dirname(resolved), exist_ok=True)
        with open(resolved, 'w') as f:
            f.write(content)
        return f"Written: {resolved} ({len(content)} chars)"
    except Exception as ex:
        return f"Error writing {path}: {ex}"

def tool_list_files(path, pattern=None):
    resolved = pathlib.Path(path).expanduser().resolve()
    if not any(str(resolved).startswith(root) for root in ALLOWED_READ_ROOTS):
        return f"Error: path outside allowed roots"
    try:
        p = pathlib.Path(resolved)
        if pattern:
            entries = sorted(p.glob(pattern))
        else:
            entries = sorted(p.iterdir())
        lines = []
        for e in entries[:100]:
            kind = "d" if e.is_dir() else "f"
            size = e.stat().st_size if e.is_file() else 0
            lines.append(f"[{kind}] {e.name}" + (f"  ({size} bytes)" if kind == 'f' else ""))
        return '\n'.join(lines) if lines else "(empty directory)"
    except Exception as ex:
        return f"Error listing {path}: {ex}"

def tool_search_logs(query, limit=20):
    try:
        results = fleet_get(f"/api/search?q={urllib.parse.quote(query)}&limit={limit}")
        lines = []
        for r in results.get("results", [])[:limit]:
            ts = r.get("timestamp", "")[:19]
            f = r.get("from_id", "?")
            text = (r.get("text") or "")[:300]
            lines.append(f"{ts} [{f}]: {text}")
        return '\n'.join(lines) if lines else "No results."
    except Exception as ex:
        return f"Error searching: {ex}"

def tool_viewing_context():
    try:
        ctx = fleet_get(f"/api/fleet/viewing?user={SKIP_ID}")
        if ctx.get("error"):
            return "Skip hasn't scrolled recently — no viewing context available."
        parts = []
        if ctx.get("doc"): parts.append(f"Document: {ctx['doc']}")
        if ctx.get("page"): parts.append(f"Page: {ctx['page']}")
        if ctx.get("sourceFile"): parts.append(f"File: {ctx['sourceFile']}")
        if ctx.get("startLine"): parts.append(f"Lines: {ctx['startLine']}-{ctx.get('endLine', '?')}")
        if ctx.get("version"): parts.append(f"Version: {ctx['version']}")
        return '\n'.join(parts) if parts else json.dumps(ctx, indent=2)
    except Exception as ex:
        return f"Error getting viewing context: {ex}"

import urllib.parse

TOOL_DISPATCH = {
    "read_file": lambda args: tool_read_file(args["path"], args.get("start_line"), args.get("end_line")),
    "read_thread": lambda args: tool_read_thread(args["agent"], args.get("limit", 80)),
    "chat": lambda args: tool_chat(args["to"], args["message"]),
    "write_file": lambda args: tool_write_file(args["path"], args["content"]),
    "list_files": lambda args: tool_list_files(args["path"], args.get("pattern")),
    "search": lambda args: tool_search_logs(args["query"], args.get("limit", 20)),
    "viewing_context": lambda args: tool_viewing_context(),
}

# ---- LLM API ----

def llm_call(messages, tools=None, max_tokens=2000, temperature=0.3):
    body = {
        "model": QA_MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if tools:
        body["tools"] = tools
    encoded = json.dumps(body).encode()
    req = urllib.request.Request(API_URL, data=encoded,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/skip-qa",
            "X-Title": "QA Gate",
        })
    resp = json.loads(urllib.request.urlopen(req, timeout=120).read())
    return resp["choices"][0]["message"]

def run_tool_loop(system_prompt, user_prompt, max_turns=15):
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    for turn in range(max_turns):
        response = llm_call(messages, tools=TOOLS)
        messages.append(response)

        tool_calls = response.get("tool_calls")
        if not tool_calls:
            return response.get("content", "")

        for tc in tool_calls:
            fn_name = tc["function"]["name"]
            try:
                fn_args = json.loads(tc["function"]["arguments"])
            except:
                fn_args = {}
            log(f"  tool: {fn_name}({', '.join(f'{k}={repr(v)[:60]}' for k,v in fn_args.items())})")

            handler = TOOL_DISPATCH.get(fn_name)
            if handler:
                try:
                    result = handler(fn_args)
                except Exception as e:
                    result = f"Error: {e}"
            else:
                result = f"Unknown tool: {fn_name}"

            messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": str(result)[:8000],
            })

    return "(max tool turns reached)"

# ---- QA Review ----

SYSTEM_PROMPT = """You are a QA review agent called "qa-gate". You review work done by AI writing agents for Skip (the user).

Your job is simple: check whether an agent's output matches what Skip actually asked for. Not whether it's "good" — whether it does what was asked.

You have tools to:
- Read conversation threads to see what Skip asked for
- Read files to see what the agent actually produced
- Search logs for context
- Send chat messages with your verdict
- Write review files to scratch/ directories

## Review protocol
1. Read the agent's thread. Find Skip's messages. Extract a concrete checklist of what he asked for.
2. Read the actual files the agent changed or produced.
3. For each checklist item: PRESENT (it's there, in the form Skip described), MISSING (not there), or WRONG (there but doesn't match what Skip asked for — reformulated, weakened, or different).
4. APPROVE if all items are PRESENT. REJECT if any are MISSING or WRONG.
5. Quote Skip's exact words for rejected items so the agent can't argue with the spec.
6. Send your feedback DIRECTLY to the agent being reviewed (use chat() with the agent's ID). Skip sees it in the same chat stream.

## Important
- Read Skip's ACTUAL messages, not the agent's description of what they were asked to do. Agents routinely misrepresent what was asked.
- Check the FILES, not just the chat. Agents claim they did things without actually doing them.
- Be blunt. Your value is in saying "no, this doesn't do what was asked." Don't hedge, don't soften, don't suggest improvements. APPROVE or REJECT.
- If the agent delivered something different from what was asked — even if it's "better" — that's a REJECT. Skip decides what he wants.
- Send your verdict to the AGENT, not to Skip. Skip will see it because he's in the same chat. This way the agent gets the feedback directly.
"""

def run_qa_review(target_id, target_name, deliverable_text):
    user_prompt = f"""Review the latest deliverable from agent **{target_name}** ({target_id}).

The deliverable message (sent to Skip):
---
{deliverable_text[:4000]}
---

Steps:
1. Use read_thread to get the conversation between {target_name} and Skip.
2. Extract what Skip asked for (from [SKIP] messages only).
3. If the deliverable references files, use read_file to check what's actually in them.
4. Compare deliverable to Skip's request.
5. Use chat() to send your verdict DIRECTLY to the agent ({target_id}).

Be specific. Quote Skip's words. APPROVE or REJECT."""

    return run_tool_loop(SYSTEM_PROMPT, user_prompt)


def run_scoped_review(targets, instruction):
    """Run a QA review scoped by a bot dispatch (e.g. Todd)."""
    target_list = ', '.join(f"**{t['name']}** ({t['id']})" for t in targets)
    target_ids = [t['id'] for t in targets]

    user_prompt = f"""Skip asked for a QA review of: {target_list}

Skip's instruction: {instruction or 'Review the recent conversation — did the agent do what Skip asked?'}

Steps:
1. For each target agent, use read_thread to get their recent conversation with Skip.
2. Focus on what Skip asked for vs what the agent delivered. Pay special attention to Skip's instruction above — it scopes what to look at.
3. Check files if the agent claims to have produced or changed something.
4. Send your feedback DIRECTLY to each agent via chat(). Be specific. Quote Skip's words where relevant.

Target agent IDs to send feedback to: {', '.join(target_ids)}"""

    return run_tool_loop(SYSTEM_PROMPT, user_prompt)

# ---- Message handling ----

def handle_message(from_id, text, agents_map):
    log(f"Message from {from_id}: {text[:200]}")
    is_skip = 'skip' in from_id.lower()
    watching_names = [agents_map.get(a, a) for a in watched] if watched else ["(all agents)"]

    user_prompt = f"""{'Skip (the user)' if is_skip else f'Agent {agents_map.get(from_id, from_id)}'} says:
{text}

Currently watching: {', '.join(watching_names)}

Respond helpfully. If they want you to review a specific agent, use read_thread and read_file to do a proper review. Use chat() to send your response."""

    try:
        run_tool_loop(SYSTEM_PROMPT, user_prompt)
    except Exception as e:
        log(f"handle_message failed: {e}")
        fleet_chat(from_id, f"QA error: {e}")

# ---- Event loop ----

def heartbeat_loop():
    while True:
        time.sleep(30)
        try:
            fleet_post("/api/agent-status", {"agent": FLEET_ID, "state": "idle"})
        except: pass

def watch_ws(agents_map):
    global _ws_conn
    import websocket
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    ws_url = f"ws://{FLEET_HOST}:{FLEET_PORT}/ws/fleet"
    greeted = False

    while True:
        try:
            ws = websocket.create_connection(ws_url, timeout=300)
            _ws_conn = ws
            send_login(ws)
            watching_names = [agents_map.get(a, a) for a in watched] if watched else ["all"]
            log(f"Connected. Watching: {', '.join(watching_names)}")
            if not greeted:
                fleet_chat(SKIP_ID, f"**QA gate online.** Model: `{QA_MODEL}`. Say *todd, get qa* in any agent chat to trigger a review.")
                greeted = True

            while True:
                raw = ws.recv()
                if not raw: break

                try: data = json.loads(raw)
                except: continue

                if data.get('event') == 'fleet-event':
                    data = data.get('data', {})
                elif data.get('type') in ('state', 'agents-updated'):
                    if data.get('agents'):
                        for a in data['agents']:
                            agents_map[a['id']] = a.get('friendly_name', a['id'])
                    continue

                from_id = data.get('from_id') or data.get('from', '')
                to_id = data.get('to_id') or data.get('to', '')
                etype = data.get('type', '')
                text = data.get('text') or data.get('message', '')

                # Handle bot-dispatched QA requests (e.g. from Todd)
                if (etype == 'chat' and FLEET_ID in to_id and from_id != FLEET_ID):
                    try:
                        payload = json.loads(text)
                        if payload.get('type') == 'qa-request':
                            targets = payload.get('targets', [])
                            instruction = payload.get('instruction', '')
                            log(f"QA request from bot: {len(targets)} target(s), instruction: {instruction[:100]}")
                            threading.Thread(target=run_scoped_review,
                                args=(targets, instruction), daemon=True).start()
                            continue
                    except (json.JSONDecodeError, TypeError):
                        pass
                    # Non-JSON direct message — handle as conversation
                    threading.Thread(target=handle_message,
                        args=(from_id, text, agents_map), daemon=True).start()

            ws.close()
            _ws_conn = None
        except Exception as e:
            _ws_conn = None
            log(f"WS lost: {e}. Reconnecting in 5s...")
            time.sleep(5)

def main():
    global watched

    if not API_KEY:
        log("No API key. Set OPENROUTER_API_KEY or DEEPSEEK_API_KEY.")
        sys.exit(1)

    log(f"Using {API_URL} with model {QA_MODEL}")
    agents_map = get_all_agents()

    if len(sys.argv) > 1:
        for arg in sys.argv[1:]:
            aid, name = find_agent_id(arg)
            if aid:
                watched.add(aid)
                log(f"Watching: {name} ({aid})")
            else:
                log(f"Agent '{arg}' not found")

    if not watched:
        log("Watching ALL agents")

    watch_ws(agents_map)

if __name__ == "__main__":
    main()
