// @tlda/bot — the lifecycle harness for a tlda-compatible bot.
//
// A standing bot (todd, teacher) is a long-lived fleet participant: it holds a
// single fleet id, registers, keeps a WebSocket alive with reconnect/backoff,
// owns a pidfile (so the supervisor can keep exactly one alive), and dispatches
// chat messages addressed to it. todd and teacher hand-rolled all of this
// identically; this factors it into one surface:
//
//   import { runBot } from '@tlda/bot'
//   const bot = runBot({ name: 'teacher', human: true, labels: ['bot','teacher'] })
//   bot.onCommand(({ text, from, reply }) => {
//     if (text === 'ping') reply('pong')
//   })
//
// Identity is config-driven exactly like the shipped example: TLDA_BOT_NAME and
// TLDA_BOT_PIDFILE override `name`/pidfile, so the supervisor can run the same
// script under any name. `name` is the fallback when run by hand.

import WebSocket from 'ws';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getServerUrl } from '../../shared/config.mjs';

export function createBot({ name = 'bot', labels = ['bot'], human = false, allow = null, server } = {}) {
  const key = (process.env.TLDA_BOT_NAME || name).toLowerCase();
  const id = 'fleet:' + key;
  const SERVER = server || process.env.TLDA_SERVER || getServerUrl();
  const WS_URL = SERVER.replace(/^http/, 'ws') + '/ws/fleet';
  const PID_FILE = process.env.TLDA_BOT_PIDFILE || join(homedir(), '.config', 'tlda', `${key}.pid`);
  const allowSet = allow ? new Set(allow) : null;

  let ws = null, msgId = 1, reconnectTimer = null, reconnectDelay = 500;
  const pending = new Map();
  const cbs = { command: [], message: [], open: [], close: [] };

  const log = (...a) => console.log(`[${key}]`, ...a);
  const fire = (ev, data) => { for (const cb of cbs[ev]) { try { cb(data); } catch (e) { log('handler error:', e.message); } } };

  function connect() {
    ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
    ws.on('open', () => { log(`connected to ${WS_URL}`); reconnectDelay = 500; register(); fire('open'); });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
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
  function send(msg) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msgId++, ...msg })); }
  function request(msg, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('WS not connected'));
      const rid = msgId++;
      const timer = setTimeout(() => { pending.delete(rid); reject(new Error('timeout')); }, timeoutMs);
      pending.set(rid, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: rid, ...msg }));
    });
  }
  function register() {
    send({ type: 'register', id, name: key, cwd: process.cwd(), labels, human });
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
    fire('message', msg);
    if (msg.type !== 'chat') return;
    const from = msg.from_id ?? msg.from;
    if (from === id) return; // ignore our own echoes
    const cmd = addressedText(msg);
    if (cmd === null) return;
    if (allowSet && !allowSet.has(from)) return; // not authorized to command this bot
    fire('command', { text: cmd, from, to: msg.to_id, raw: msg, reply: (m) => chat(from, m) });
  }

  function start() {
    // Singleton: if a live pidfile exists, bail (the supervisor runs exactly one).
    if (existsSync(PID_FILE)) {
      const existing = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
      try { process.kill(existing, 0); log(`already running (pid ${existing}) — exiting`); process.exit(0); } catch {}
    }
    try { writeFileSync(PID_FILE, String(process.pid)); } catch {}
    const cleanup = () => { try { unlinkSync(PID_FILE); } catch {} };
    process.on('SIGINT', () => { log('shutting down'); cleanup(); ws?.close(); process.exit(0); });
    process.on('exit', cleanup);
    log(`starting (pid ${process.pid}) on ${SERVER}`);
    connect();
    return api;
  }
  function stop() { try { ws?.close(); } catch {} }

  const api = {
    id, key, name: key, server: SERVER,
    start, stop, send, request, chat, addressedText,
    onCommand: (cb) => { cbs.command.push(cb); return api; },
    onMessage: (cb) => { cbs.message.push(cb); return api; },
    onOpen: (cb) => { cbs.open.push(cb); return api; },
    onClose: (cb) => { cbs.close.push(cb); return api; },
  };
  return api;
}

export function runBot(opts) { return createBot(opts).start(); }
