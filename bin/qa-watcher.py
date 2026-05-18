#!/usr/bin/env python3
"""
DeepSeek QA Agent — fleet agent that reviews writing agents' deliverables.

Spawnable via fleet-spawn. Watches all writing agents by default.
Controllable via fleet chat — just talk to it naturally.

Usage: python3 qa-watcher.py [agent1 agent2 ...]
  No args = watch all agents. Args = watch specific agents.

Environment:
  FLEET_ID          — this agent's fleet ID (set by fleet-spawn)
  FLEET_DASH_PORT   — fleet server port (default 5176)
  OPENAI_API_KEY    — DeepSeek API key
  DEEPSEEK_API_KEY  — alternative key name
"""

import json, os, sys, time, urllib.request, threading, struct, socket, base64

FLEET_HOST = os.environ.get('FLEET_DASH_HOST', '127.0.0.1')
FLEET_PORT = os.environ.get('FLEET_DASH_PORT', '5176')
FLEET_API = f"http://{FLEET_HOST}:{FLEET_PORT}"
FLEET_ID = os.environ.get('FLEET_ID', 'fleet:deepseek-qa')
API_KEY = os.environ.get('OPENAI_API_KEY', '') or os.environ.get('DEEPSEEK_API_KEY', '')
SKIP_ID = 'fleet:skip'

# Watched agents — start with args or all
watched = set()

def log(msg):
    print(f"[qa] {msg}", file=sys.stderr, flush=True)

def fleet_chat(to, message):
    data = json.dumps({"message": message, "to": to, "from": FLEET_ID}).encode()
    req = urllib.request.Request(f"{FLEET_API}/api/chat", data=data,
        headers={"Content-Type": "application/json"}, method="POST")
    try: return json.loads(urllib.request.urlopen(req, timeout=30).read())
    except Exception as e: log(f"chat failed: {e}"); return None

def fleet_get(path):
    req = urllib.request.Request(f"{FLEET_API}{path}")
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

def register():
    """Register via WebSocket (the only way that works with the tlda server)."""
    import websocket  # pip install websocket-client; fallback to raw socket if missing
    ws_url = f"ws://{FLEET_HOST}:{FLEET_PORT}/ws/fleet"
    try:
        import websocket as ws_mod
        ws = ws_mod.create_connection(ws_url, timeout=5)
        ws.send(json.dumps({
            "type": "register",
            "agent_id": FLEET_ID,
            "name": "qa-gate",
            "cwd": os.getcwd(),
            "machine_id": socket.gethostname().split('.')[0],
        }))
        # Wait for welcome
        try:
            resp = ws.recv()
            log(f"Registered: {json.loads(resp).get('type', '?')}")
        except: pass
        ws.close()
    except ImportError:
        # Fallback: raw socket WS handshake for registration
        log("websocket-client not installed, using raw socket registration")
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
                payload = json.dumps({
                    "type": "register", "agent_id": FLEET_ID,
                    "name": "qa-gate", "cwd": os.getcwd(),
                    "machine_id": socket.gethostname().split('.')[0],
                }).encode()
                frame = bytes([0x81, len(payload)]) + payload
                s.sendall(frame)
                time.sleep(0.5)
                log("Registered via raw WS")
            s.close()
        except Exception as e:
            log(f"Registration failed: {e}")

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

def get_thread(agent_id, limit=50):
    events = fleet_get(f"/api/store/events?agent={agent_id}&limit={limit}").get("events", [])
    lines = []
    for e in events:
        f = e.get("from_id", "?")
        ts = e.get("timestamp", "")[:19]
        text = (e.get("text") or "")[:800]
        role = "[SKIP]" if "skip" in f.lower() else f"[{f}]"
        lines.append(f"{ts} {role}: {text}")
    return lines

def deepseek(prompt, max_tokens=1500, temperature=0.3):
    req_data = json.dumps({
        "model": "deepseek-chat",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": temperature,
        "max_tokens": max_tokens
    }).encode()
    req = urllib.request.Request("https://api.deepseek.com/chat/completions", data=req_data,
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"})
    resp = json.loads(urllib.request.urlopen(req, timeout=90).read())
    return resp["choices"][0]["message"]["content"]

def run_qa_review(target_id, target_name, deliverable_text):
    thread = get_thread(target_id, limit=80)
    prompt = f"""# QA Review Protocol

You are reviewing work done by agent {target_name} for Skip.

CRITICAL: Read Skip's actual messages below. Ignore the agent's description of what they were asked to do.

## Thread (recent messages):
{chr(10).join(thread[-40:])}

## Deliverable ({target_name}'s message):
{deliverable_text}

## Instructions
1. Read ALL of Skip's messages [SKIP]. Extract what he asked for — make a concrete checklist.
2. Read the deliverable.
3. For each checklist item: PRESENT, MISSING, or WRONG.
4. If all PRESENT → APPROVE. If any MISSING/WRONG → REJECT with specifics.
5. Quote Skip's exact words for rejected items.
6. Format as markdown with a checklist table.
7. Be concise — under 500 words."""
    return deepseek(prompt)

def handle_message(from_id, text, agents_map):
    """Handle any message sent to this QA agent. Uses DeepSeek to respond."""
    log(f"Message from {from_id}: {text[:200]}")
    is_skip = 'skip' in from_id.lower()

    watching_names = [agents_map.get(a, a) for a in watched] if watched else ["(all agents)"]
    all_agents = [v for v in agents_map.values() if v]

    prompt = f"""You are a QA review agent called "qa-gate" in a fleet of AI agents working on a math paper for Skip.
You watch writing agents and review their deliverables for quality.

Currently watching: {', '.join(watching_names)}
All known agents: {', '.join(all_agents)}

{'Skip (the user)' if is_skip else f'Agent {agents_map.get(from_id, from_id)}'} says:
{text}

You can:
- If they want you to watch/monitor a specific agent, respond with WATCH:<agent_name>
- If they want you to stop watching an agent, respond with UNWATCH:<agent_name>
- If they want you to review a specific agent's latest work, respond with REVIEW:<agent_name>
- Otherwise just respond helpfully and concisely (under 200 words).

Put commands on their own line at the END of your response."""

    try:
        reply = deepseek(prompt, max_tokens=500, temperature=0.4)

        # Parse commands from response
        clean_reply = []
        for line in reply.split('\n'):
            stripped = line.strip()
            if stripped.startswith('WATCH:'):
                name = stripped[6:].strip()
                aid, aname = find_agent_id(name)
                if aid:
                    watched.add(aid)
                    agents_map[aid] = aname
                    clean_reply.append(f"Now watching **{aname}**.")
                    log(f"Added watch: {aname} ({aid})")
            elif stripped.startswith('UNWATCH:'):
                name = stripped[8:].strip()
                aid, aname = find_agent_id(name)
                if aid and aid in watched:
                    watched.discard(aid)
                    clean_reply.append(f"Stopped watching **{aname}**.")
                    log(f"Removed watch: {aname} ({aid})")
            elif stripped.startswith('REVIEW:'):
                name = stripped[7:].strip()
                aid, aname = find_agent_id(name)
                if aid:
                    clean_reply.append(f"Reviewing **{aname}**'s latest...")
                    # Trigger review in background
                    def do_review(a_id, a_name):
                        events = fleet_get(f"/api/store/events?agent={a_id}&limit=50").get("events", [])
                        latest = ""
                        for e in reversed(events):
                            if a_id in e.get("from_id", "") and len(e.get("text", "")) > 200:
                                latest = e["text"][:4000]
                                break
                        if latest:
                            verdict = run_qa_review(a_id, a_name, latest)
                            fleet_chat(a_id, f"**QA REVIEW:**\n\n{verdict}")
                            fleet_chat(from_id, f"Review of {a_name} posted.")
                        else:
                            fleet_chat(from_id, f"No recent deliverable from {a_name}.")
                    threading.Thread(target=do_review, args=(aid, aname), daemon=True).start()
            else:
                clean_reply.append(line)

        fleet_chat(from_id, '\n'.join(clean_reply).strip())
    except Exception as e:
        log(f"Reply failed: {e}")

def heartbeat_loop():
    """Send periodic heartbeats so the server doesn't mark us dead."""
    while True:
        time.sleep(30)
        try:
            # Update last_seen via agent status endpoint
            data = json.dumps({"agent": FLEET_ID, "state": "idle"}).encode()
            req = urllib.request.Request(f"{FLEET_API}/api/agent-status",
                data=data, headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=5)
        except:
            pass

def watch_ws(agents_map):
    """Connect to fleet WebSocket and watch for deliverables."""
    import websocket

    threading.Thread(target=heartbeat_loop, daemon=True).start()

    ws_url = f"ws://{FLEET_HOST}:{FLEET_PORT}/ws/fleet"

    while True:
        try:
            ws = websocket.create_connection(ws_url, timeout=300)
            watching_names = [agents_map.get(a, a) for a in watched] if watched else ["all"]
            log(f"Connected. Watching: {', '.join(watching_names)}")

            while True:
                raw = ws.recv()
                if not raw: break

                try: data = json.loads(raw)
                except: continue

                # Fleet WS wraps events as { event: "fleet-event", data: {...} }
                if data.get('event') == 'fleet-event':
                    data = data.get('data', {})
                elif data.get('type') in ('state', 'agents-updated'):
                    # State updates — refresh agent map
                    if data.get('agents'):
                        for a in data['agents']:
                            agents_map[a['id']] = a.get('friendly_name', a['id'])
                    continue

                from_id = data.get('from_id') or data.get('from', '')
                to_id = data.get('to_id') or data.get('to', '')
                etype = data.get('type', '')
                text = data.get('text') or data.get('message', '')

                # Deliverable: watched agent → skip, substantial message
                is_watched = not watched or from_id in watched
                if (etype == 'chat' and is_watched and
                    from_id != FLEET_ID and
                    'skip' in to_id.lower() and
                    len(text) > 200):

                    name = agents_map.get(from_id, from_id)
                    log(f"Deliverable from {name} ({len(text)} chars). Reviewing...")
                    try:
                        verdict = run_qa_review(from_id, name, text)
                        fleet_chat(from_id, f"**QA REVIEW:**\n\n{verdict}")
                        fleet_chat(SKIP_ID, f"QA reviewed {name}'s latest. Verdict posted.")
                        log("Verdict posted.")
                    except Exception as e:
                        log(f"Review failed: {e}")
                        fleet_chat(SKIP_ID, f"QA review of {name} failed: {e}")

                # Direct message to this QA agent
                if FLEET_ID in to_id and etype == 'chat' and from_id != FLEET_ID:
                    threading.Thread(target=handle_message,
                        args=(from_id, text, agents_map), daemon=True).start()

            ws.close()
        except Exception as e:
            log(f"WS lost: {e}. Reconnecting in 5s...")
            time.sleep(5)

def main():
    global watched

    if not API_KEY:
        log("No API key. Set OPENAI_API_KEY or DEEPSEEK_API_KEY.")
        sys.exit(1)

    register()
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

    watching_names = [agents_map.get(a, a) for a in watched] if watched else ["all writing agents"]
    fleet_chat(SKIP_ID, f"**QA gate online.** Watching: {', '.join(watching_names)}. Chat me to add/remove targets or trigger reviews.")

    watch_ws(agents_map)

if __name__ == "__main__":
    main()
