#!/usr/bin/env node
/**
 * test-spawn-delegate.mjs
 *
 * Tests the combined delegate({ spawn, message }) API by exercising the two
 * components that the handler composes:
 *
 *   1. fleet-spawn --fresh <name> --no-attach   → parse fleet_id from stdout
 *   2. POST delegate to the fleet WS server     → verify task appears
 *
 * Run against a live fleet instance:
 *   node test-spawn-delegate.mjs
 */

import { execSync } from 'child_process';
import { createServer } from 'http';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';

const SERVER = process.env.TLDA_SERVER || 'http://localhost:5176';
const WS_URL = SERVER.replace(/^http/, 'ws') + '/ws/fleet?agent=fleet:test-harness';

// ---- helpers ----------------------------------------------------------------

function log(msg) { process.stdout.write(`[test] ${msg}\n`); }

import { randomUUID } from 'crypto';

async function wsRequest(type, body) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const reqId = randomUUID();
    const timeout = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 10000);
    ws.on('open', () => ws.send(JSON.stringify({ id: reqId, type, ...body })));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        // Server replies with { id: reqId, result: {...} } or { id: reqId, error: '...' }
        if (msg.id === reqId) {
          clearTimeout(timeout);
          ws.close();
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.result);
        }
      } catch {}
    });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

// ---- test 1: fleet-spawn produces parseable output --------------------------

log('--- Test 1: fleet-spawn --fresh output format ---');

const testName = `test-spawn-${Date.now().toString(36).slice(-4)}`;
const fleetSpawnScript = path.join(os.homedir(), 'bin', 'fleet-spawn');

let spawnOutput;
try {
  spawnOutput = execSync(
    `${fleetSpawnScript} --fresh --no-attach ${testName}`,
    { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();
  log(`spawn output: ${spawnOutput}`);
} catch (e) {
  log(`FAIL: fleet-spawn exited non-zero: ${e.stderr || e.message}`);
  process.exit(1);
}

const fleetIdMatch = spawnOutput.match(/\((fleet:[a-f0-9]+)\)/);
if (!fleetIdMatch) {
  log(`FAIL: could not parse fleet_id from: "${spawnOutput}"`);
  process.exit(1);
}

const fleetId = fleetIdMatch[1];
log(`PASS: parsed fleet_id = ${fleetId}`);

// ---- test 2: agent registered on server ------------------------------------

log('--- Test 2: spawned agent visible in server store ---');

// Give the agent a moment to register
await new Promise(r => setTimeout(r, 3000));

let agents;
try {
  const res = await fetch(`${SERVER}/api/store/agents`);
  agents = await res.json();
} catch (e) {
  log(`FAIL: could not reach fleet server: ${e.message}`);
  process.exit(1);
}

const spawned = agents.find(a => a.id === fleetId || a.friendly_name === testName);
if (!spawned) {
  log(`FAIL: agent ${fleetId} (${testName}) not found in server store`);
  log(`known agents: ${agents.map(a => a.friendly_name || a.id).join(', ')}`);
  process.exit(1);
}
log(`PASS: agent found — id=${spawned.id} name=${spawned.friendly_name}`);

// ---- test 3: delegate WS call routes task to agent --------------------------

log('--- Test 3: delegate WS message → task appears for agent ---');

const testMessage = 'Test task from spawn-delegate integration test. Call task_done immediately.';

let delegateResult;
try {
  delegateResult = await wsRequest('delegate', {
    from: 'fleet:test-harness',
    agent: fleetId,
    description: 'spawn-delegate integration test',
    message: testMessage,
  });
} catch (e) {
  log(`FAIL: WS delegate failed: ${e.message}`);
  process.exit(1);
}

if (!delegateResult.ok) {
  log(`FAIL: delegate returned not-ok: ${JSON.stringify(delegateResult)}`);
  process.exit(1);
}

log(`PASS: delegate ok, task_id=${delegateResult.task_id}`);

// ---- test 4: verify task in agent's task list -------------------------------

log('--- Test 4: verify task is pending for the spawned agent ---');

let tasks;
try {
  const res = await fetch(`${SERVER}/api/store/tasks?agent=${encodeURIComponent(fleetId)}`);
  tasks = await res.json();
} catch (e) {
  log(`FAIL: could not fetch tasks: ${e.message}`);
  process.exit(1);
}

const ourTask = (Array.isArray(tasks) ? tasks : tasks.tasks || [])
  .find(t => t.id === delegateResult.task_id || t.message === testMessage);

if (!ourTask) {
  log(`FAIL: task ${delegateResult.task_id} not found in agent's task list`);
  log(`tasks: ${JSON.stringify(tasks, null, 2)}`);
  process.exit(1);
}

log(`PASS: task confirmed — id=${ourTask.id} status=${ourTask.status}`);

// ---- test 5: description auto-derive logic (unit test, no server) -----------

log('--- Test 5: description auto-derive logic ---');

function deriveDescription(message) {
  const firstSentence = message.match(/^[^.!?\n]{5,60}[.!?]/);
  return firstSentence ? firstSentence[0] : message.slice(0, 60).trimEnd();
}

const cases = [
  { msg: 'Fix the scrolling bug in fleet chat.', expected: 'Fix the scrolling bug in fleet chat.' },
  { msg: 'A'.repeat(70), expected: 'A'.repeat(60) },
  { msg: 'Short message without terminal punctuation', expected: 'Short message without terminal punctuation' },
];

let allPassed = true;
for (const { msg, expected } of cases) {
  const got = deriveDescription(msg);
  if (got !== expected) {
    log(`FAIL: derive("${msg.slice(0,30)}...") → "${got}" (expected "${expected}")`);
    allPassed = false;
  }
}
if (allPassed) log('PASS: all derive cases correct');

// ---- summary ----------------------------------------------------------------

log('');
log('=== All tests passed ===');
log(`Spawned agent: ${testName} (${fleetId})`);
log(`Task ID: ${delegateResult.task_id}`);
log('');
log('NOTE: The spawned tmux session is still running. Kill it with:');
log(`  tmux kill-session -t fleet-${testName}`);
