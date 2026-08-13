// @tlda/bot — the lifecycle harness for a tlda-compatible bot.
//
// A standing bot (todd, teacher) is a long-lived fleet participant: it uses the
// fleet id supplied by the harness, keeps a WebSocket alive with
// reconnect/backoff, owns a pidfile, and dispatches chat messages addressed to
// it only when the allocator assigned that canonical name.
//
//   import { runBot } from '@tlda/bot'
//   const bot = runBot({ name: 'teacher', labels: ['bot'] })
//   bot.onCommand(({ text, from, reply }) => {
//     if (text === 'ping') reply('pong')
//   })
//
// Identity is config-driven: TLDA_BOT_NAME and TLDA_BOT_PIDFILE override
// `name`/pidfile, FLEET_ID is supplied by the harness, and TLDA_BOT_MACHINE_ID /
// TLDA_BOT_TMUX_SESSION wire it into normal fleet lifecycle machinery.

import WebSocket from 'ws';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { getServerUrl } from '../../shared/config.mjs';
import { ResilientWS } from '../../shared/resilient-ws.mjs';
import { createCommandRegistry } from './commands.mjs';

// A bot carries `bot`, and it is not the caller's to leave off. Skip, 2026-08-13:
// "I think all bots should probably carry the bot label … obviously it's the
// implementer's choice, but that's my choice."
//
// It is load-bearing rather than descriptive: todd's don't-nudge-a-bot guard tests
// this exact string (`bots/todd/lib/kicks.mjs`), so a bot without it gets kicked
// like a person. Adding it here rather than at each call site means the assertion
// rides every login — the payload is rebuilt on each connect — so a row that loses
// the label recovers on the next reconnect instead of staying wrong until somebody
// reads the roster.
//
// Humans are untouched: a `human` participant is not a bot and does not get it.
function registrationLabels(labels, key, { human = false } = {}) {
  const out = human ? [] : ['bot'];
  for (const label of Array.isArray(labels) ? labels : []) {
    if (!label || label === key || out.includes(label)) continue;
    out.push(label);
  }
  return out;
}

async function confirmRegisteredFromRoster(server, id, timeoutMs = 10_000) {
  const url = new URL('/api/agents/lookup', server);
  url.searchParams.set('ids', id);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`agent lookup failed: HTTP ${res.status}`);
  const data = await res.json();
  const agents = data?.agents || [];
  return agents.find(a => a?.id === id && !a?.dead) || null;
}

export function createBot({
  name = 'bot', pretty_name = null, labels = ['bot'], human = false, allow = null, server,
  commands = [], cwd = process.cwd(), metadata = {}, fleetId = null,
  pidFile = null, WebSocketClass = WebSocket, handshakeTimeoutMs = 10_000,
  reconnectInitialMs = 500, reconnectMaxMs = 5000,
} = {}) {
  const key = (process.env.TLDA_BOT_NAME || name).toLowerCase();
  const SERVER = server || process.env.TLDA_SERVER || getServerUrl();
  const WS_URL = SERVER.replace(/^http/, 'ws') + '/ws/fleet';
  const PID_FILE = process.env.TLDA_BOT_PIDFILE || pidFile || join(homedir(), '.config', 'tlda', `${key}.pid`);
  const MACHINE_ID = process.env.TLDA_BOT_MACHINE_ID || null;
  const ENV_NAME = process.env.TLDA_ENV || null;
  const DAEMON_KEY = process.env.FLEET_DAEMON_KEY || null;
  const TMUX_SESSION = process.env.TLDA_BOT_TMUX_SESSION || null;
  const id = fleetId || process.env.FLEET_ID;
  if (!/^fleet:[a-zA-Z0-9_-]+$/.test(id || '')) throw new Error('bot harness requires FLEET_ID');
  const explicitLabels = registrationLabels(labels, key, { human });
  const allowSet = allow ? new Set(allow) : null;
  const registry = createCommandRegistry(commands);

  let msgId = 1, stopped = false;
  let assignedName = null;
  const pending = new Map();
  const waiters = new Set();
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

  // Every bot connected to this package used to get a second implementation of
  // reconnect/backoff, hand-rolled here beside the one in shared/resilient-ws.
  // The two disagreed on the rule that matters: this one reset the delay inside
  // ws.on('open'), one line before the login that can throw, so a server that was
  // UP and REJECTING logins was retried at the floor delay forever — testing Todd
  // did that twice a second for 3.5 hours against the daemon-route gate. The
  // shared client resets only after a connection has stayed up (stableConnectionMs),
  // which is the same rule its own comment states, and it covers the
  // server-is-down case identically. Reply correlation and canonical-name gating
  // stay here; they sit above the socket, not in it.
  //
  // TLS: the hand-rolled socket passed `rejectUnauthorized: false` for every URL,
  // not just local dev. That is preserved verbatim below rather than tightened as
  // a side effect of a refactor — changing who a bot will trust is a separate
  // decision from where its backoff resets.
  class BotSocket extends WebSocketClass {
    constructor(url, options) {
      super(url, { rejectUnauthorized: false, ...(options || {}) });
    }
  }

  const rws = new ResilientWS({
    url: () => WS_URL,
    label: key,
    initialBackoffMs: reconnectInitialMs,
    maxBackoffMs: reconnectMaxMs,
    // Bounded handshake: a peer that accepts the TCP connection and never answers
    // the upgrade would otherwise leave the socket in CONNECTING forever with no
    // event to reconnect on. Previously `handshakeTimeout` on the ws constructor;
    // the shared client does this with its own timer and defaults it OFF, so it
    // has to be passed explicitly to keep the behaviour.
    connectAttemptTimeoutMs: handshakeTimeoutMs,
    WebSocketImpl: BotSocket,
    onOpen: async () => {
      log(`connected to ${WS_URL}`);
      try {
        const result = await loginFleet();
        // Inertness gates the whole bot, not just its mouth. Skip, 2026-08-13:
        // "Inertness should gate the entirety of bot behavior … if a bot is
        // fucking up, you make them inert by changing their name."
        //
        // `onOpen` is where a bot starts its periodic work — dev arms its preview
        // sweep here, nobody its poll — so a renamed bot that still ran this hook
        // was silenced at the fleet surface and carried on working locally. That
        // is the state `quiet-dev` was in: unreachable and still sweeping.
        //
        // Placed here rather than in each bot's callback because the next bot
        // written would not know to add the check. `nobody` already opens with
        // `if (!bot.isCanonical()) return`, which is this rule discovered once and
        // not shared; that line becomes redundant rather than wrong.
        //
        // Safe at this point specifically: `loginFleet` has resolved, so the
        // assigned name — and therefore canonicality — is known. Earlier in the
        // socket's life it is not.
        if (isCanonical()) fire('open', result);
      } catch (e) {
        log(`login failed: ${e.message}`);
        // reconnect(), not close(): close() disarms the retry loop entirely.
        rws.reconnect();
      }
    },
    onMessage: (msg) => {
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        pending.delete(msg.id); clearTimeout(timer);
        if (msg.error) reject(new Error(typeof msg.error === 'string' ? msg.error : (msg.error.message || JSON.stringify(msg.error))));
        else resolve(msg.result);
        return;
      }
      dispatch(msg);
    },
    onClose: () => { fire('close'); },
  });

  function connect() { rws.connect(); }
  function sendRaw(msg) { if (rws.connected) rws.send({ id: msgId++, ...msg }); }
  function send(msg) { if (isCanonical()) sendRaw(msg); }
  function requestRaw(msg, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      if (!rws.connected) return reject(new Error('WS not connected'));
      const rid = msgId++;
      const timer = setTimeout(() => {
        pending.delete(rid);
        reject(new Error(`${msg?.type || 'ws request'} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(rid, { resolve, reject, timer });
      rws.send({ id: rid, ...msg });
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
      cwd,
      labels: explicitLabels,
      human,
      kind: human ? undefined : 'bot',
      machine_id: MACHINE_ID || undefined,
      env_name: ENV_NAME || undefined,
      daemon_key: DAEMON_KEY || undefined,
      tmux_session: TMUX_SESSION || undefined,
      metadata: { bot: key, model: key, pid: process.pid, ...metadata },
    };
    let result;
    try {
      if (human) {
        result = await requestRaw({ ...basePayload, type: 'register', human: true });
      } else {
        result = await requestRaw({ ...basePayload, type: 'login' });
      }
    } catch (e) {
      const agent = await confirmRegisteredFromRoster(SERVER, id);
      if (!agent) throw e;
      log('login reply timed out; confirmed live registration from roster');
      result = { ok: true, agent };
    }
    updateAssignedNameFromAgent(result?.agent);
    if (isCanonical()) {
      await requestRaw({
        type: 'subscribe-filter',
        subId: `bot-chat-${id}`,
        filter: [[['to', id]], [['from', id]]],
        window: 0,
      });
    }
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
    if (recipientsOf(data).includes(id)) return t;
    return null;
  }

  // One event, many recipients. A chat addressed to this bot puts its id in the
  // recipient SET; there is no scalar `to_id` on the envelope any more, so
  // reading one would leave the bot deaf to every direct message that did not
  // also open with its name.
  function recipientsOf(data) {
    const list = data?.recipients ?? data?.to;
    if (Array.isArray(list)) return list.filter(Boolean);
    return list ? [list] : [];
  }

  function dispatch(msg) {
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(msg)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
      return;
    }
    if (msg.agents && !msg.event) {
      updateAssignedNameFromAgent((msg.agents || []).find(a => a.id === id));
      return;
    }
    if (msg.event === 'agents-delta') {
      updateAssignedNameFromAgent((msg.data?.changed || []).find(a => a.id === id));
      return;
    }
    if (!isCanonical()) return;
    // The server wraps chats in a fleet-event envelope: { event, data: { type, from_id, recipients, text } }.
    if (msg.event === 'filter-event') {
      msg = { event: 'fleet-event', data: msg.data?.event || {} };
    }
    fire('message', msg);
    if (msg.event !== 'fleet-event') return;
    const data = msg.data || {};
    if (data.type !== 'chat') return;
    const from = data.from_id ?? data.from;
    if (from === id) return; // ignore our own echoes
    const cmd = addressedText(data);
    if (cmd === null) return;
    if (allowSet && !allowSet.has(from)) return; // not authorized to command this bot
    const context = { text: cmd, to: recipientsOf(data), from, raw: msg, bot: api, reply: (m) => chat(from, m) };
    fire('command', context);
    if (registry.commands.length || /^help(?:\s|$)/i.test(cmd)) {
      registry.dispatch(cmd, context).catch(error => log('command error:', error.message));
    }
  }

  function start() {
    stopped = false;
    // Singleton: if a live pidfile exists, bail (the supervisor runs exactly one).
    if (existsSync(PID_FILE)) {
      const existing = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
      // kill(pid, 0) throws iff the process is gone → stale pidfile, so we fall
      // through and take over. It only reaches exit() when a live instance owns it.
      try { process.kill(existing, 0); log(`already running (pid ${existing}) — exiting`); process.exit(0); } catch { /* stale pid — take over */ }
    }
    writeFileSync(PID_FILE, String(process.pid));
    const cleanup = () => { try { unlinkSync(PID_FILE); } catch { /* already gone */ } };
    process.on('SIGINT', () => { log('shutting down'); cleanup(); rws.close(); process.exit(0); });
    process.on('exit', cleanup);
    log(`starting (pid ${process.pid}) on ${SERVER}`);
    connect();
    return api;
  }
  function waitFor(predicate, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error('timeout'));
      }, timeoutMs);
      waiters.add(waiter);
    });
  }
  async function sendAndWait(message, predicate, timeoutMs = 10_000) {
    if (!isCanonical()) throw new Error(`bot "${key}" is not canonical (assigned ${assignedName || 'none'})`);
    const result = waitFor(predicate, timeoutMs);
    sendRaw(message);
    return result;
  }
  function stop() {
    stopped = true;
    rws.close();
  }

  const api = {
    id, key, name: key, server: SERVER,
    get assignedName() { return assignedName; },
    get canonical() { return isCanonical(); },
    isCanonical, registry,
    start, stop, send, request, waitFor, sendAndWait, chat, addressedText,
    onCommand: (cb) => { cbs.command.push(cb); return api; },
    onMessage: (cb) => { cbs.message.push(cb); return api; },
    onOpen: (cb) => { cbs.open.push(cb); return api; },
    onClose: (cb) => { cbs.close.push(cb); return api; },
  };
  return api;
}

export function runBot(opts) { return createBot(opts).start(); }

export { createCommandRegistry, generateCommandMarkdown } from './commands.mjs';
export { configTypes, defineConfig, generateConfigMarkdown, parseConfig } from './config.mjs';
export { createTransportFixture } from './fixture.mjs';

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
  getFleetServerUrl,         // grammar, lint, dev
  getManagedBots,            // grammar, lint, dev
  getManagedBotEnvironments, // dev
  getActiveEnvName,       // dev
  getReadToken,
} from '../../shared/config.mjs';
export { labelsForAgent } from '../../shared/fleet-labels.mjs';        // todd, dev
export { startWsRequest } from '../../shared/ws-request-policy.mjs';   // all bots
export { checkChatRender } from '../../shared/chat-render-check.mjs';  // lint
export { runtimeStatusName } from '../../shared/fleet-runtime-status.mjs'; // todd/kicks, todd/activity-report
export { reapIdlePreviews } from '../../cli/lib/dev-worktree.mjs';     // dev
