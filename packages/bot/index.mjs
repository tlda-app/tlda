// @tlda/bot — the lifecycle harness for a tlda-compatible bot.
//
// A standing bot (todd, teacher) is a long-lived fleet participant: it holds a
// persisted fleet id, requests a canonical friendly name from the allocator,
// keeps a WebSocket alive with reconnect/backoff, owns a pidfile, and dispatches
// chat messages addressed to it only when the allocator assigned that canonical
// name. todd and teacher hand-rolled most of this identically; this factors it
// into one surface:
//
//   import { runBot } from '@tlda/bot'
//   const bot = runBot({ name: 'teacher', labels: ['bot','teacher'] })
//   bot.onCommand(({ text, from, reply }) => {
//     if (text === 'ping') reply('pong')
//   })
//
// Identity is config-driven: TLDA_BOT_NAME and TLDA_BOT_PIDFILE override
// `name`/pidfile, TLDA_BOT_IDFILE persists the fleet id, and TLDA_BOT_MACHINE_ID
// / TLDA_BOT_TMUX_SESSION wire it into normal fleet lifecycle machinery.

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { getServerUrl } from '../../shared/config.mjs';

function loadOrCreateFleetId(file) {
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (/^fleet:[a-zA-Z0-9_-]+$/.test(existing)) return existing;
    throw new Error(`invalid bot fleet id "${existing}"`);
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  const id = `fleet:${randomUUID().slice(0, 8)}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, id);
  return id;
}

async function confirmRegisteredFromRoster(server, id, timeoutMs = 10_000) {
  const res = await fetch(`${server}/api/store/agents`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`roster check failed: HTTP ${res.status}`);
  const data = await res.json();
  const agents = Array.isArray(data) ? data : (data?.agents || []);
  return agents.find(a => a?.id === id && !a?.dead) || null;
}

export function createBot({ name = 'bot', pretty_name = null, labels = ['bot'], human = false, allow = null, server } = {}) {
  const key = (process.env.TLDA_BOT_NAME || name).toLowerCase();
  const SERVER = server || process.env.TLDA_SERVER || getServerUrl();
  const WS_URL = SERVER.replace(/^http/, 'ws') + '/ws/fleet';
  const PID_FILE = process.env.TLDA_BOT_PIDFILE || join(homedir(), '.config', 'tlda', `${key}.pid`);
  const ID_FILE = process.env.TLDA_BOT_IDFILE || join(dirname(PID_FILE), `${key}.fleet-id`);
  const MACHINE_ID = process.env.TLDA_BOT_MACHINE_ID || null;
  const TMUX_SESSION = process.env.TLDA_BOT_TMUX_SESSION || null;
  const id = loadOrCreateFleetId(ID_FILE);
  const allowSet = allow ? new Set(allow) : null;

  let ws = null, msgId = 1, reconnectTimer = null, reconnectDelay = 500;
  let assignedName = null;
  const pending = new Map();
  const cbs = { command: [], message: [], open: [], close: [] };

  const log = (...a) => console.log(`[${key}]`, ...a);
  const fire = (ev, data) => {
    for (const cb of cbs[ev]) {
      try {
        cb(data);
      } catch (e) {
        // Callback failure should not break the bot websocket loop.
        log('handler error:', e.message);
      }
    }
  };

  function updateAssignedNameFromAgent(agent) {
    if (!agent || agent.id !== id) return;
    const next = agent.friendly_name || null;
    if (next !== assignedName) {
      assignedName = next;
      log(`assigned_name=${assignedName || '(none)'} canonical=${isCanonical()}`);
    }
  }

  function isCanonical() {
    return assignedName === key;
  }

  function connect() {
    ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
    ws.on('open', async () => {
      log(`connected to ${WS_URL}`);
      reconnectDelay = 500;
      try {
        const result = await loginFleet();
        fire('open', result);
      } catch (e) {
        log(`login failed: ${e.message}`);
        ws?.close();
      }
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        // Ignore malformed websocket frames; the next valid frame can still proceed.
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        pending.delete(msg.id); clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error)); else resolve(msg.result);
        return;
      }
      dispatch(msg);
    });
    ws.on('close', () => { log(`disconnected, reconnecting in ${reconnectDelay}ms`); fire('close'); scheduleReconnect(); });
    ws.on('error', (e) => console.error(`[${key}] ws error:`, e.message));
  }
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  }
  function sendRaw(msg) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msgId++, ...msg })); }
  function send(msg) { if (isCanonical()) sendRaw(msg); }
  function requestRaw(msg, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('WS not connected'));
      const rid = msgId++;
      const timer = setTimeout(() => { pending.delete(rid); reject(new Error('timeout')); }, timeoutMs);
      pending.set(rid, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: rid, ...msg }));
    });
  }
  function request(msg, timeoutMs = 10_000) {
    if (!isCanonical()) return Promise.reject(new Error(`bot "${key}" is not canonical (assigned ${assignedName || 'none'})`));
    return requestRaw(msg, timeoutMs);
  }
  async function loginFleet() {
    const basePayload = {
      agent_id: id,
      name: key,
      pretty_name,
      cwd: process.cwd(),
      labels,
      human,
      machine_id: MACHINE_ID || undefined,
      tmux_session: TMUX_SESSION || undefined,
      metadata: { bot: key, pid: process.pid },
    };
    let result;
    try {
      if (human) {
        result = await requestRaw({ ...basePayload, type: 'register', human: true });
      } else {
        await requestRaw({ ...basePayload, type: 'reserve-shell' });
        result = await requestRaw({ ...basePayload, type: 'login' });
      }
    } catch (e) {
      const agent = await confirmRegisteredFromRoster(SERVER, id);
      if (!agent) throw e;
      log('login reply timed out; confirmed live registration from roster');
      result = { ok: true, agent };
    }
    updateAssignedNameFromAgent(result?.agent);
    if (!isCanonical()) log(`inert: requested "${key}", assigned "${assignedName || '(none)'}"`);
    return result;
  }
  function chat(to, message) { send({ type: 'chat', from: id, to, message }); }

  // Strip an optional leading "<name>[,:]" address; return the remaining command
  // text, or null if the message neither targets this bot's id nor opens with its
  // name. Same rule todd + teacher use.
  function addressedText(data) {
    const text = data.text;
    if (!text) return null;
    const t = text.trim();
    const addressed = new RegExp(`^${key}\\b[,:]?\\s*`, 'i');
    if (addressed.test(t)) return t.replace(addressed, '').trim();
    if (data.to_id === id) return t;
    return null;
  }

  function dispatch(msg) {
    if (msg.agents && !msg.event) {
      updateAssignedNameFromAgent((msg.agents || []).find(a => a.id === id));
      return;
    }
    if (msg.event === 'agents-delta') {
      updateAssignedNameFromAgent((msg.data?.changed || []).find(a => a.id === id));
      return;
    }
    if (!isCanonical()) return;
    fire('message', msg);
    // The server wraps chats in a fleet-event envelope: { event, data: { type, from_id, to_id, text } }.
    if (msg.event !== 'fleet-event') return;
    const data = msg.data || {};
    if (data.type !== 'chat') return;
    const from = data.from_id ?? data.from;
    if (from === id) return; // ignore our own echoes
    const cmd = addressedText(data);
    if (cmd === null) return;
    if (allowSet && !allowSet.has(from)) return; // not authorized to command this bot
    fire('command', { text: cmd, from, to: data.to_id, raw: msg, reply: (m) => chat(from, m) });
  }

  function start() {
    // Singleton: if a live pidfile exists, bail (the supervisor runs exactly one).
    if (existsSync(PID_FILE)) {
      const existing = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
      // kill(pid, 0) throws iff the process is gone → stale pidfile, so we fall
      // through and take over. It only reaches exit() when a live instance owns it.
      try { process.kill(existing, 0); log(`already running (pid ${existing}) — exiting`); process.exit(0); } catch { /* stale pid — take over */ }
    }
    writeFileSync(PID_FILE, String(process.pid));
    const cleanup = () => { try { unlinkSync(PID_FILE); } catch { /* already gone */ } };
    process.on('SIGINT', () => { log('shutting down'); cleanup(); ws?.close(); process.exit(0); });
    process.on('exit', cleanup);
    log(`starting (pid ${process.pid}) on ${SERVER}`);
    connect();
    return api;
  }
  function stop() { ws?.close(); }

  const api = {
    id, key, name: key, server: SERVER,
    get assignedName() { return assignedName; },
    get canonical() { return isCanonical(); },
    isCanonical,
    start, stop, send, request, chat, addressedText,
    onCommand: (cb) => { cbs.command.push(cb); return api; },
    onMessage: (cb) => { cbs.message.push(cb); return api; },
    onOpen: (cb) => { cbs.open.push(cb); return api; },
    onClose: (cb) => { cbs.close.push(cb); return api; },
  };
  return api;
}

export function runBot(opts) { return createBot(opts).start(); }

// ── App surface for out-of-repo bots ────────────────────────────────────────
//
// A bot repo (todd, grammar, dev, lint, disposition, teacher) lives outside this
// repository and depends on it as `"@tlda/bot": "file:../tlda/packages/bot"`. npm
// installs a `file:` directory dependency as a symlink, so the relative reaches
// above resolve back into the real app checkout — that is why teacher has always
// worked from `~/work/teacher`.
//
// Before the bots moved out they imported `../shared/config.mjs` and friends
// directly, which only worked because they sat inside this tree. These
// re-exports are that same access, routed through the package boundary instead
// of a relative path that no longer exists.
//
// This list is exactly what the moved bots use, and nothing speculative — a
// package surface is a promise. Do not add a symbol here "for completeness";
// add it when a bot actually imports it.
export {
  CONFIG_DIR,                // todd, grammar, lint, dev, disposition
  getServerUrl,              // todd, dev, disposition
  getFleetServerUrl,         // grammar, lint, dev, todd/lib/disclosure/dataset
  getManagedBots,            // grammar, lint, dev
  getManagedBotEnvironments, // dev
  getActiveEnvName,       // dev
  getReadToken,              // todd/lib/disclosure/dataset
} from '../../shared/config.mjs';
export { labelsForAgent } from '../../shared/fleet-labels.mjs';        // todd, dev
export { startWsRequest } from '../../shared/ws-request-policy.mjs';   // all bots
export { checkChatRender } from '../../shared/chat-render-check.mjs';  // lint
export { runtimeStatusName } from '../../shared/fleet-runtime-status.mjs'; // todd/kicks, todd/activity-report
