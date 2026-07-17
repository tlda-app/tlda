/**
 * Count-based idle chat-render invariant.
 *
 * Stable idle input after initial settle gets one baseline observation. Actual
 * FleetChatInner renders or .fleet-chat-log geometry/scroll movement after that
 * baseline increment the count; without a chat-relevant input change the count
 * must stay exactly 1.
 */

import { execSync } from 'child_process'
import test from 'node:test'
import { setup, teardown, getScrollState, sendChat, pwEval, pwResult, Suite, delay } from '../harness.mjs'

const previewPort = parseInt(process.env.TLDA_TEST_PORT || '5179')
const previewPrereq = `requires worktree preview server on :${previewPort} - start with tlda-dev serve`

function hasWorktreePreviewServer() {
  try {
    execSync(`curl -skf -o /dev/null --max-time 2 https://localhost:${previewPort}/`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (!hasWorktreePreviewServer()) {
  test('idle chat render count', { skip: previewPrereq }, () => {})
} else {
const suite = new Suite('idle chat render count')

function getBestLogExpression() {
  return `(function(){
    var els=document.querySelectorAll(".fleet-chat-log");
    var best=null,bestC=-1;
    for(var i=0;i<els.length;i++){
      var c=els[i].querySelectorAll(".chat-line").length;
      if(c>bestC){bestC=c;best=els[i]}
    }
    if(!best)return null;
    var r=best.getBoundingClientRect();
    return {
      dist:Math.round(best.scrollHeight-best.scrollTop-best.clientHeight),
      sH:Math.round(best.scrollHeight),
      sT:Math.round(best.scrollTop),
      cH:Math.round(best.clientHeight),
      top:Math.round(r.top),
      left:Math.round(r.left),
      width:Math.round(r.width),
      height:Math.round(r.height),
      msgs:bestC
    };
  })()`
}

function readLogSample(ctx) {
  const raw = pwResult(pwEval(ctx.sessionName, `(function(){return JSON.stringify(${getBestLogExpression()})})()`))
  return raw && raw !== 'null' ? JSON.parse(raw) : null
}

function sameSample(a, b) {
  return !!a && !!b &&
    a.dist === b.dist &&
    a.sH === b.sH &&
    a.sT === b.sT &&
    a.cH === b.cH &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height &&
    a.msgs === b.msgs
}

async function waitForIdleSettle(ctx, { timeoutMs = 15000, intervalMs = 250, stableReads = 5 } = {}) {
  const start = Date.now()
  let prev = null
  let stable = 0
  while (Date.now() - start < timeoutMs) {
    const sample = readLogSample(ctx)
    if (sameSample(prev, sample)) stable++
    else stable = 1
    prev = sample
    if (sample && stable >= stableReads) return sample
    await delay(intervalMs)
  }
  throw new Error('chat log did not settle before idle-count observation')
}

function startRenderCounter(ctx) {
  pwEval(ctx.sessionName, `(function(){
    window.__tldaFleetChatRenderCounter = {active:true, renderCount:0, events:[]};
    return "ok";
  })()`)
}

function stopRenderCounter(ctx) {
  pwEval(ctx.sessionName, `(function(){
    if(window.__tldaFleetChatRenderCounter) window.__tldaFleetChatRenderCounter.active = false;
    return "ok";
  })()`)
}

function clearRenderCounter(ctx) {
  pwEval(ctx.sessionName, `(function(){
    delete window.__tldaFleetChatRenderCounter;
    return "ok";
  })()`)
}

function readRenderReport(ctx) {
  const raw = pwResult(pwEval(ctx.sessionName, `(function(){return JSON.stringify(window.__tldaFleetChatRenderCounter || null)})()`))
  return raw && raw !== 'null' ? JSON.parse(raw) : null
}

function forceExtraRenderCount(ctx) {
  pwEval(ctx.sessionName, `(function(){
    var c=window.__tldaFleetChatRenderCounter;
    if(!c)return "no-counter";
    c.renderCount=(c.renderCount||0)+1;
    if(!c.events)c.events=[];
    c.events.push({type:"render", t:performance.now(), shapeId:"forced-count-selftest"});
    return "forced";
  })()`)
}

async function observeIdleCount(ctx, { durationMs = 3500, churn = null, forceExtraCount = false } = {}) {
  const baseline = await waitForIdleSettle(ctx)
  startRenderCounter(ctx)
  const samples = [baseline]
  let movementCount = 0
  let prev = baseline
  let churnStarted = false
  const start = Date.now()
  while (Date.now() - start < durationMs) {
    const elapsed = Date.now() - start
    if (churn && !churnStarted && elapsed >= 500) {
      churnStarted = true
      churn()
    }
    if (forceExtraCount && elapsed >= 1000) {
      forceExtraCount = false
      forceExtraRenderCount(ctx)
    }
    await delay(200)
    const sample = readLogSample(ctx)
    samples.push(sample)
    if (!sameSample(prev, sample)) movementCount++
    prev = sample
  }
  stopRenderCounter(ctx)
  const report = readRenderReport(ctx) || { renderCount: 0, events: [] }
  const count = 1 + (report.renderCount || 0) + movementCount
  return { count, renderCount: report.renderCount || 0, movementCount, baseline, final: samples[samples.length - 1], events: report.events || [] }
}

function assertExactlyOne(observation, label) {
  return {
    pass: observation.count === 1,
    detail: `${label}: count=${observation.count} render=${observation.renderCount} movement=${observation.movementCount} baselineDist=${observation.baseline?.dist} finalDist=${observation.final?.dist}`,
  }
}

function sendHeartbeatOnlyChurn(ctx) {
  for (let i = 0; i < 5; i++) {
    ctx.fleetWs.send(JSON.stringify({
      type: 'login',
      agent_id: ctx.recipientId,
      name: ctx.recipientName,
      cwd: process.cwd(),
      labels: ['bot', 'scroll-test'],
    }))
  }
}

function systemLoad() {
  try {
    return execSync('uptime', { encoding: 'utf8', timeout: 3000 }).trim()
  } catch (e) {
    return `uptime unavailable: ${e.message}`
  }
}

const ctx = await setup({})

try {
  console.log(`[load] ${systemLoad()}`)

  await suite.run('chat HUD renders before invariant observation', () => {
    const state = getScrollState(ctx)
    return Promise.resolve(state
      ? { pass: true, detail: `msgs=${state.msgs} sH=${state.sH} dist=${state.dist}` }
      : { pass: false, detail: 'no .fleet-chat-log' })
  })

  const idle = await observeIdleCount(ctx)
  await suite.run('settled idle input has exactly one render/movement count', () =>
    Promise.resolve(assertExactlyOne(idle, 'idle')))

  const heartbeat = await observeIdleCount(ctx, { churn: () => sendHeartbeatOnlyChurn(ctx) })
  await suite.run('heartbeat-only churn keeps render/movement count at one', () =>
    Promise.resolve(assertExactlyOne(heartbeat, 'heartbeat')))

  sendChat(ctx, { from: ctx.agentId, message: 'chat-relevant input for idle render count guard' })
  await delay(1200)
  const afterChat = await waitForIdleSettle(ctx)
  await suite.run('real chat-relevant input may change settled chat state', () =>
    Promise.resolve(afterChat && afterChat.msgs > heartbeat.final.msgs
      ? { pass: true, detail: `msgs ${heartbeat.final.msgs}->${afterChat.msgs}` }
      : { pass: false, detail: `message count did not increase: before=${heartbeat.final?.msgs} after=${afterChat?.msgs}` }))

  if (process.env.TLDA_IDLE_RENDER_COUNT_SELFTEST_FAIL === '1') {
    const forced = await observeIdleCount(ctx, { forceExtraCount: true })
    await suite.run('forced count>1 self-test must fail', () =>
      Promise.resolve(assertExactlyOne(forced, 'forced')))
  }
} finally {
  clearRenderCounter(ctx)
  await teardown(ctx)
}

const r = suite.summary()
process.exit(r.failed > 0 ? 1 : 0)
}
