#!/usr/bin/env node
// export-thread.mjs — dump an agent's COMPLETE thread to a verbatim markdown file.
//
// "Their thread" = every event where the agent is sender OR recipient, in time
// order: chats with Skip, chats with other agents, eliza nudges, build pings,
// and the agent's own activity. No summarization, no truncation. Default
// captures all event types; --types narrows.
//
// Usage:
//   node bin/export-thread.mjs --agent fleet:a3510d83 --since 2026-05-22T20:30 --until 2026-05-22T21:30 --out out.md
//   node bin/export-thread.mjs --agent curvature-3 ... --types chat,delegate
//   node bin/export-thread.mjs --batch jobs.json
//   node bin/export-thread.mjs --md scratch/drill-corpus/EXPORT-LIST.md --out-dir scratch/drill-corpus/transcripts
//
// jobs.json: [{ "agent": "...", "since": "...", "until": "...", "path": "...", "types"?: ["chat"] }]
//
// Time values are ISO strings compared lexically against the DB's UTC
// timestamps (which is how the log viewer displays them), so pass times the way
// they appear in the logs — no timezone conversion needed.

import WebSocket from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getServerUrl } from '../shared/config.mjs';

const PAGE = 5000; // server cap; tight windows fit in one page

// DB timestamps are UTC (…Z). Windows are given in local time the way the log
// viewer shows them (JS parses a no-offset datetime as local), so normalize to
// UTC ISO for the query. An explicit Z/offset passes through unchanged.
function toUtc(v) {
  if (!v || v === true) return undefined;
  const d = new Date(v);
  return isNaN(d) ? v : d.toISOString();
}

// ---- arg parsing ----
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { a[key] = true; }
      else { a[key] = next; i++; }
    }
  }
  return a;
}

// ---- WS client ----
function makeClient() {
  const server = getServerUrl();
  const wsUrl = server.replace(/^http/, 'ws') + '/ws/fleet?agent=' + encodeURIComponent('fleet:export-thread');
  const ws = new WebSocket(wsUrl, { rejectUnauthorized: false });
  const pending = new Map();
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, timer } = pending.get(m.id);
      clearTimeout(timer); pending.delete(m.id);
      if (m.error) reject(new Error(m.error)); else resolve(m.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  function call(msg) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('WS timeout for ' + msg.type)); }, 30000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...msg, id }));
    });
  }
  return { ws, ready, call, close: () => ws.close() };
}

// ---- agent name resolution ----
function resolveAgent(agents, ref) {
  if (!ref) return null;
  const exact = agents.find(a => a.id === ref || a.friendly_name === ref || a.id === `fleet:${ref}`);
  if (exact) return exact.id;
  const pref = agents.find(a => a.id.startsWith(ref));
  return pref ? pref.id : ref; // fall back to the raw ref (may already be a fleet:UUID)
}

// ---- fetch the complete thread for one agent over [since, until) ----
async function fetchThread(call, agentId, since, until, types) {
  const byId = new Map();
  let cursor = toUtc(since);
  const untilUtc = toUtc(until);
  let total = null;
  let guard = 0;
  while (guard++ < 1000) {
    const params = { type: 'store-events', agent: agentId, limit: PAGE };
    if (cursor) params.since = cursor;
    if (untilUtc) params.until = untilUtc;
    if (types && types.length) params.event_types = types;
    const r = await call(params);
    const events = r?.events || [];
    if (r?.total != null) total = r.total;
    for (const e of events) byId.set(e.id, e);
    if (events.length < PAGE) break;
    const lastTs = events[events.length - 1].timestamp;
    if (lastTs === cursor) break; // no forward progress (page-boundary ts collision)
    cursor = lastTs;
  }
  return { events: [...byId.values()].sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '')), total };
}

// ---- formatting ----
function fmtTs(ts) {
  // Render in local time — matches how the log viewer shows times and the zone
  // the export windows are specified in.
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function bodyFor(e) {
  if (e.type === 'delegate') return `[DELEGATE] ${e.description || ''}\n${e.message || e.text || ''}`.trim();
  if (e.type === 'task_done') return `[DONE] ${e.description || ''}`.trim();
  return e.text || e.message || '';
}

function renderEvent(e, nameOf) {
  const from = nameOf(e.from || e.from_id) || '?';
  const to = nameOf(e.to || e.to_id) || '?';
  const tag = (e.type && e.type !== 'chat') ? ` (${e.type})` : '';
  return `[${fmtTs(e.timestamp)}] ${from} → ${to}${tag}\n${bodyFor(e)}`;
}

// ---- one export job ----
async function runJob(call, nameOf, job) {
  const { events, total } = await fetchThread(call, job.agentId, job.since, job.until, job.types);
  const headerLines = [
    `# Thread: ${job.label}`,
    ``,
    `- agent: \`${job.agentId}\``,
    `- window: ${job.since || '(start)'} … ${job.until || '(end)'}`,
    `- types: ${job.types && job.types.length ? job.types.join(', ') : 'all'}`,
    `- messages: ${events.length}`,
    ``,
    `---`,
    ``,
  ];
  const body = events.map(e => renderEvent(e, nameOf)).join('\n\n---\n\n');
  fs.mkdirSync(path.dirname(path.resolve(job.path)), { recursive: true });
  fs.writeFileSync(job.path, headerLines.join('\n') + body + '\n');
  const complete = total == null || events.length >= total;
  return { path: job.path, count: events.length, total, complete };
}

// ---- markdown-table batch (parse a pipe table with file/agent/since/until columns) ----
function jobsFromMarkdown(mdPath, outDir) {
  const text = fs.readFileSync(mdPath, 'utf8');
  const lines = text.split('\n');
  const jobs = [];
  let header = null;
  for (const line of lines) {
    if (!line.trim().startsWith('|')) { header = null; continue; }
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length && cells.every(c => /^:?-+:?$/.test(c))) continue; // separator row (|---|---|)
    const lower = cells.map(c => c.toLowerCase().replace(/`/g, ''));
    if (lower.includes('agent') && lower.includes('since') && lower.includes('until')) { header = lower; continue; }
    if (!header) continue;
    const get = (name) => { const i = header.indexOf(name); return i >= 0 ? cells[i].replace(/`/g, '').trim() : ''; };
    const agent = get('agent'), since = get('since'), until = get('until');
    if (!agent || !since || !until) continue;
    const file = (get('file') || `${agent.replace(/[^a-z0-9]+/gi, '-')}.md`);
    jobs.push({ agent, since, until, path: path.join(outDir || '.', file) });
  }
  return jobs;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  let rawJobs = [];
  if (a.batch) {
    rawJobs = JSON.parse(fs.readFileSync(a.batch, 'utf8'));
  } else if (a.md) {
    rawJobs = jobsFromMarkdown(a.md, a['out-dir']);
    if (!rawJobs.length) { console.error('No table rows with file/agent/since/until found in ' + a.md); process.exit(1); }
  } else if (a.agent && a.out) {
    rawJobs = [{ agent: a.agent, since: a.since, until: a.until, path: a.out, types: a.types ? String(a.types).split(',') : undefined }];
  } else {
    console.error('Usage:\n  --agent <id|name> --since <iso> --until <iso> --out <path> [--types chat,delegate]\n  --batch <jobs.json>\n  --md <table.md> --out-dir <dir>');
    process.exit(1);
  }

  const { ready, call, close } = makeClient();
  try { await ready; } catch (e) { console.error('Could not connect to fleet WS:', e.message); process.exit(1); }

  const agents = (await call({ type: 'store-agents' })) || [];
  const nameMap = new Map();
  for (const ag of agents) nameMap.set(ag.id, ag.friendly_name || ag.id);
  const nameOf = (id) => id ? (nameMap.get(id) || id) : null;

  const results = [];
  for (const j of rawJobs) {
    const agentId = resolveAgent(agents, j.agent);
    const types = j.types ? (Array.isArray(j.types) ? j.types : String(j.types).split(',')) : undefined;
    const label = `${j.agent} ${j.since || ''}–${j.until || ''}`.trim();
    try {
      const res = await runJob(call, nameOf, { agentId, since: j.since, until: j.until, types, path: j.path, label });
      results.push(res);
      const warn = res.complete ? '' : `  ⚠️ INCOMPLETE (${res.count}/${res.total})`;
      console.log(`✓ ${res.path}  (${res.count} messages)${warn}`);
    } catch (e) {
      console.error(`✗ ${j.path || j.agent}: ${e.message}`);
      results.push({ path: j.path, error: e.message });
    }
  }

  close();
  const incomplete = results.filter(r => r.error || r.complete === false);
  console.log(`\nDone: ${results.length - incomplete.length}/${results.length} clean.`);
  process.exit(incomplete.length ? 2 : 0);
}

main();
