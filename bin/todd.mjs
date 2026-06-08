#!/usr/bin/env node
/**
 * Todd — the shipped EXAMPLE bot. A pseudo-agent that watches Skip's chat
 * messages for frustration signals and sends the target agent a corrective
 * nudge. Pure regex pattern matching, no LLM. Registers as a fleet agent and
 * communicates via chat like any agent — it just happens to be automated.
 *
 * tlda knows nothing about "Todd": the server's managed-bot supervisor keeps
 * whatever bots are listed in config alive (default: this one), and the
 * suggestion/nudge channel + `suggest` MCP tool are generic. Identity is
 * env-driven (TLDA_BOT_NAME) so the same script can run under another name —
 * write your own bot the same way.
 *
 * Started automatically by the server/CLI supervisor; not run by hand.
 */

import WebSocket from 'ws'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import https from 'https'
import http from 'http'
import { execFile } from 'child_process'
import { promisify } from 'util'
const execFileP = promisify(execFile)

import { getServerUrl, CONFIG_DIR } from '../shared/config.mjs'
import { labelsForAgent } from '../shared/fleet-labels.mjs'
import { commitMdShare } from './md-share-commit.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Identity is config-driven: the supervisor passes TLDA_BOT_NAME (and the pidfile
// path it owns). This is the shipped EXAMPLE bot — todd — but it reads its own
// name so anyone can run the same script under a different name. The key drives
// the fleet id, pidfile, the display name, and the address verb Skip speaks.
// Names are lowercase by fleet convention (fleet:skip, fleet:todd, …).
const BOT_KEY = (process.env.TLDA_BOT_NAME || 'todd').toLowerCase()
const AGENT_ID = 'fleet:' + BOT_KEY
const AGENT_NAME = BOT_KEY
const VERB = BOT_KEY  // what Skip says to address this bot, e.g. "todd cancel"
const PID_FILE = process.env.TLDA_BOT_PIDFILE || path.join(CONFIG_DIR, `${BOT_KEY}.pid`)
const SERVER = getServerUrl()
const WS_URL = SERVER.replace(/^http/, 'ws') + '/ws/fleet'
const OWNER_ID = 'fleet:skip'

// ---- Decision log ----
// JSONL file recording every action + state snapshot for later HMM training.
// Each line: { ts, agent, action, trigger, state, text_snippet, reward? }
const DECISIONS_LOG = path.join(CONFIG_DIR, `${BOT_KEY}-decisions.jsonl`)

// Positive/negative reward signal patterns in Skip's messages (post-nudge)
const POSITIVE_REWARD_PATTERNS = [
  /\b(that was great|perfect|exactly|much better|now we'?re (getting|talking)|thank you|okay good|that'?s (right|it|better|great))\b/i,
  /^(yes|yeah|yep|great|good|perfect|nice|exactly)\b/i,
]
const NEGATIVE_REWARD_PATTERNS = [
  /\b(that sucked|still not|ugh|this is exhausting|not (right|what I wanted|correct))\b/i,
  /^(bro|wtf)\s*$/i,
  /\bdismissive\b/i,
]
// Note: "fuck you" removed from negative rewards — repeated "fuck you" during an
// ongoing frustration episode was registering as negative feedback on the nudge,
// when it's really the same episode continuing. The fuck-you-in-context detector
// handles the escalation pattern separately.

// Track pending reward observations: agentId → { nudgeTs, nudgeAction, positiveCount, negativeCount, windowDone }
const pendingRewards = new Map()
const REWARD_WINDOW_MS = 10 * 60_000 // watch 10 min after nudge

function logDecision(agentId, action, trigger, stateSnapshot, textSnippet) {
  const record = {
    ts: new Date().toISOString(),
    agent: agentId,
    action,   // 'performing-understanding' | 'fuck-you-in-context' | 'punt' | 'running-away' | 'single-trigger:<pattern>'
    trigger,  // what caused this
    state: stateSnapshot,
    text: textSnippet?.slice(0, 120) || '',
  }
  try {
    fs.appendFileSync(DECISIONS_LOG, JSON.stringify(record) + '\n')
  } catch (e) {
    console.error(`[todd] log write failed: ${e.message}`)
  }
}

function logReward(agentId, nudgeTs, nudgeAction, reward, rewardText) {
  const record = {
    ts: new Date().toISOString(),
    agent: agentId,
    type: 'reward',
    nudge_ts: nudgeTs,
    nudge_action: nudgeAction,
    reward,  // +1 | -1 | 0
    text: rewardText?.slice(0, 120) || '',
  }
  try {
    fs.appendFileSync(DECISIONS_LOG, JSON.stringify(record) + '\n')
  } catch (e) {
    console.error(`[todd] log write failed: ${e.message}`)
  }
}

function startRewardWindow(agentId, action) {
  pendingRewards.set(agentId, {
    nudgeTs: new Date().toISOString(),
    nudgeAction: action,
    positiveCount: 0,
    negativeCount: 0,
    windowStart: Date.now(),
  })
}

function observeRewardSignal(agentId, text) {
  const pending = pendingRewards.get(agentId)
  if (!pending) return
  if (Date.now() - pending.windowStart > REWARD_WINDOW_MS) {
    // Window expired — log neutral and close
    if (pending.positiveCount === 0 && pending.negativeCount === 0) {
      logReward(agentId, pending.nudgeTs, pending.nudgeAction, 0, null)
    }
    pendingRewards.delete(agentId)
    return
  }
  if (POSITIVE_REWARD_PATTERNS.some(p => p.test(text))) {
    pending.positiveCount++
    logReward(agentId, pending.nudgeTs, pending.nudgeAction, 1, text)
    pendingRewards.delete(agentId) // close window on first clear signal
  } else if (NEGATIVE_REWARD_PATTERNS.some(p => p.test(text))) {
    pending.negativeCount++
    logReward(agentId, pending.nudgeTs, pending.nudgeAction, -1, text)
    pendingRewards.delete(agentId)
  }
}

// Expire reward windows that are past their window
setInterval(() => {
  const now = Date.now()
  for (const [agentId, pending] of pendingRewards) {
    if (now - pending.windowStart > REWARD_WINDOW_MS) {
      logReward(agentId, pending.nudgeTs, pending.nudgeAction, 0, null)
      pendingRewards.delete(agentId)
    }
  }
}, 60_000)

// ---- Gated nudge queue ----
// All autonomous nudges go here instead of sendChat(). Skip says "Todd [label]"
// to release a specific nudge. Nudges expire after N messages in the conversation.
const pendingNudgeQueue = []  // [{ id, label, targetId, text, ts, msgCount: 0 }]
let nudgeIdCounter = 0
const NUDGE_EXPIRY_MESSAGES = 10

function queueNudge(targetId, label, text, opts = {}) {
  const nudge = {
    id: ++nudgeIdCounter,
    label,
    targetId,
    text,
    // 'nudge' = a gated frustration nudge released to the agent on "say it".
    // 'action' = a clickable command suggestion (e.g. hand off / get qa); clicking
    // sends `command` verbatim, which todd routes via its normal command handling.
    kind: opts.kind || 'nudge',
    command: opts.command || null,
    ts: Date.now(),
    msgCount: 0,
  }
  pendingNudgeQueue.push(nudge)
  console.log(`[todd] queued ${nudge.kind} #${nudge.id} "${label}" for ${targetId}`)
  broadcastPendingStatus()
}

// On a frustration signal, also surface "hand off" and "get qa" as clickable
// suggestions for the same agent (deduped). Clicking sends the command verbatim;
// todd's existing handoff / QA routing (keyed on to_id) does the rest.
function queueFrustrationActions(targetId) {
  const actions = [
    { label: 'hand off', command: `${VERB} hand this off`, text: 'Start a handoff — brief a fresh agent and rotate this one out.' },
    { label: 'get qa', command: `${VERB} get qa`, text: 'Send this agent to QA — a reviewer reads its thread and checks whether it did what you asked.' },
  ]
  for (const a of actions) {
    const exists = pendingNudgeQueue.some(n => n.targetId === targetId && n.kind === 'action' && n.label === a.label)
    if (!exists) queueNudge(targetId, a.label, a.text, { kind: 'action', command: a.command })
  }
}

function releaseNudge(nudge) {
  const idx = pendingNudgeQueue.indexOf(nudge)
  if (idx !== -1) pendingNudgeQueue.splice(idx, 1)
  console.log(`[todd] releasing nudge #${nudge.id} "${nudge.label}" → ${nudge.targetId}`)
  sendChat(nudge.targetId, nudge.text)
  logDecision(nudge.targetId, `released:${nudge.label}`, 'skip-requested', {}, null)
  startRewardWindow(nudge.targetId, nudge.label)
  broadcastPendingStatus()
}

function expireNudge(nudge) {
  const idx = pendingNudgeQueue.indexOf(nudge)
  if (idx !== -1) pendingNudgeQueue.splice(idx, 1)
  console.log(`[todd] expired nudge #${nudge.id} "${nudge.label}" for ${nudge.targetId} (${nudge.msgCount} msgs)`)
  logDecision(nudge.targetId, `expired:${nudge.label}`, `message-count:${nudge.msgCount}`, {}, null)
  broadcastPendingStatus()
}

// Once Skip acts on an agent (handoff / QA dispatch), its offered action chips
// are stale — drop them so they don't re-broadcast and re-appear.
function dequeueActions(targetId) {
  let removed = false
  for (let i = pendingNudgeQueue.length - 1; i >= 0; i--) {
    const n = pendingNudgeQueue[i]
    if (n.targetId === targetId && n.kind === 'action') {
      pendingNudgeQueue.splice(i, 1)
      removed = true
    }
  }
  if (removed) broadcastPendingStatus()
}

function tickNudgeMessages(agentId) {
  const toExpire = []
  for (const nudge of pendingNudgeQueue) {
    if (nudge.targetId === agentId) {
      nudge.msgCount++
      if (nudge.msgCount >= NUDGE_EXPIRY_MESSAGES) toExpire.push(nudge)
    }
  }
  for (const nudge of toExpire) expireNudge(nudge)
}

function findNudgeByLabel(label) {
  const lower = label.toLowerCase()
  // Only gated nudges are releasable; action suggestions (hand off / get qa) are
  // fired by sending their command, not by "todd <label>".
  const releasable = pendingNudgeQueue.filter(n => n.kind !== 'action')
  const byIndex = parseInt(lower, 10)
  if (!isNaN(byIndex) && byIndex >= 1 && byIndex <= releasable.length) {
    return releasable[byIndex - 1]
  }
  return releasable.find(n => n.label.toLowerCase() === lower) ||
         releasable.find(n => n.label.toLowerCase().includes(lower))
}

const RELEASE_PATTERN = new RegExp(`^${VERB}\\s+(.+)`, 'i')
const SAY_IT_PATTERN = new RegExp(`^(?:${VERB}\\s+)?say\\s+it$`, 'i')

function tryReleaseFromSkip(text) {
  if (SAY_IT_PATTERN.test(text)) {
    const first = pendingNudgeQueue.find(n => n.kind !== 'action')
    if (first) {
      releaseNudge(first)
      return true
    }
    return false
  }
  const match = text.match(RELEASE_PATTERN)
  if (match) {
    const label = match[1].trim()
    if (/^say\s+it$/i.test(label)) return false // already handled above
    const nudge = findNudgeByLabel(label)
    if (nudge) {
      releaseNudge(nudge)
      return true
    }
  }
  return false
}

// Re-enabled 2026-06-08. The footer hover bug that forced the old kill switch
// (the hover card fired across the whole chat surface) is fixed: the suggestion
// tooltip now renders in the HUD overlay layer (<SuggestionTip/> in FleetHUD),
// so only the chip label is a hover/click target. todd now publishes its
// pending queue as suggestion chips on its own row.
//
// `from` is todd (the caller), so the chips group under todd's row and the
// viewer's optimistic clear posts back under todd's own set. `targetId` is the
// agent the nudge concerns, which is where a clicked `command` is routed.
// Clicking an ACTION chip sends its routing command (e.g. "todd hand this off")
// to the target — todd snoops Skip's message and runs the handoff/QA. Clicking
// a gated NUDGE chip sends "todd <label>", releasing it exactly as if Skip had
// typed it. The two action items per target share a disjunctive group (pick one
// → both clear); gated nudges are singleton groups so each releases on its own.
function toddSuggestion(n) {
  const isAction = n.kind === 'action'
  return {
    id: `${BOT_KEY}:${n.id}`,
    label: n.label,
    text: n.text || '',
    command: isAction ? n.command : `${VERB} ${n.label}`,
    targetId: n.targetId,
    from: AGENT_ID,
    group: isAction ? `${n.targetId}:actions` : undefined,
    kind: n.kind,
    ts: n.ts,
    msgCount: n.msgCount,
  }
}
function broadcastPendingStatus() {
  const suggestions = pendingNudgeQueue.map(toddSuggestion)
  postJson('/api/suggestions', { agentId: AGENT_ID, suggestions }).catch(e =>
    console.error(`[todd] status broadcast failed: ${e.message}`)
  )
}

// ---- Trigger table ----
// Each entry: { pattern: RegExp, message: string, cooldown?: number }
// `cooldown` is per-target in ms (default 60s) — won't re-fire for the
// same agent within that window.
const TRIGGERS = [
  // Tier 1 — early intervention (catch before escalation)
  {
    pattern: /does that make sense/i,
    message: `⚠️ Skip said "does that make sense" — this may be a check-in or a sign he's not sure you're tracking. If you're not 100% clear on what he's asking, **reflect back** what you think he said before proceeding. If you are clear, just confirm and continue. Don't over-interpret this as a correction.`,
    cooldown: 120_000,
  },
  {
    pattern: /slow down/i,
    skill: 'partner-not-soloist',
    message: `⚠️ Skip asked you to slow down. You may be going too fast, being too clever, or not meeting him where he is. Read \`partner-not-soloist\`: stay in the rally, match his pace, check understanding before advancing.`,
  },
  {
    pattern: /\bcop[\s-]?out\b/i,
    message: `⚠️ Skip identified a hand-wave in your reasoning. "By definition" or "it follows" is not a proof step — it's a claim you haven't justified. State the precise claim, then prove it step by step. No shortcuts.`,
  },
  {
    pattern: /\bi'?m struggling\b/i,
    skill: 'confusion-is-evidence',
    message: `⚠️ Skip is telling you he's having trouble following. This is not a cue to explain faster or more confidently — it's a cue to suspect YOUR argument is wrong or too vague to pin down, then either name the single load-bearing step precisely or admit you don't have it. Do NOT re-explain the same thing more gently. Read \`confusion-is-evidence\`.`,
  },

  // Tier 2 — already frustrated (damage control)
  {
    pattern: /you don'?t understand/i,
    message: `🛑 **STOP.** Skip has told you that you don't understand what he's saying. Re-read his last 3 messages carefully. Identify the specific constraint or point you missed. Reflect it back to him before doing anything else. Do NOT propose a new solution.`,
  },
  {
    pattern: /\bthat'?s useless\b/i,
    skill: 'partner-not-soloist',
    message: `🛑 Your output didn't help Skip. Don't produce more of the same — ask what he specifically needs. Read \`partner-not-soloist\`: the goal is to stay in the conversation, not to ship output.`,
  },
  {
    pattern: /(?:\b(?:you'?re|you|that'?s|this is|it'?s|being|so|how|don'?t be|is|feels|super|really)\s+(?:fucking\s+)?rude\b|(?:fucking\s+)?rude\s+(?:as fuck|prick|asshole|dude)\b|^(?:fucking\s+)?rude\.?$)/im,
    skill: 'partner-not-soloist',
    message: `🛑 Skip flagged your behavior as rude. Read \`partner-not-soloist\` and \`respond-before-acting\` right now. You are performing, not collaborating. Stop, listen, respond to what he actually said.`,
  },
  {
    pattern: /\bhurtful\b|\bfeel stupid\b/i,
    skill: 'partner-not-soloist',
    message: `🛑 **Full stop.** Skip is telling you that your behavior is causing him distress. This is not about the technical content — it's about how you're engaging. Read \`partner-not-soloist\`. Acknowledge what he said. Do not defend yourself or explain. Listen.`,
  },
  {
    pattern: /i'?m not talking to you until/i,
    message: `🛑 Skip has set a boundary. He will not engage until you meet a specific condition. Read his message carefully, identify the condition, and fulfill it before saying anything else. Do not try to continue the conversation around the boundary.`,
  },

  // "bro" and "wtf" standalone — already in CLAUDE.md but reinforce
  {
    pattern: /^(?:bro|wtf)\s*$/i,
    message: `🛑 Stop. Re-read CLAUDE.md and your recent messages. Say what you think you did wrong, say how you'll fix it, then wait for confirmation.`,
  },

  // ---- Tier 3 — Behavior-naming triggers ----
  // Skip deliberately names what the agent is doing wrong. Higher signal than
  // frustration — he's labeling the pattern. Phrases, not single words (so he
  // can discuss the phenomena without triggering them).
  // Derived from reading agent threads across multiple days, not keyword searches.
  {
    pattern: /\b(?:you'?re|you are|stop)\s+(?:fucking\s+)?thrashing\b/i,
    skill: 'manager-team-stewardship',
    message: `🛑 **Thrashing.** You're killing agents and spawning replacements instead of producing work. An agent thinking for 4 minutes is not "stuck" — it's working. An agent thinking for 16 minutes might be stuck, or might be doing hard math. Killing it and spawning fresh means paying the orientation tax again for zero output.

Before you kill anything:
1. Has the agent produced ANY output since it started? Check with \`read_terminal\`, not just elapsed time.
2. Is the token counter moving? If yes, it's thinking, not stuck.
3. What will a fresh agent do differently? If the answer is "the same thing with a clean context," you're burning resources.

Read \`manager-team-stewardship\`. Three spawns and two kills with zero math produced is not managing.`,
    cooldown: 300_000,
  },
  {
    pattern: /\b(?:this is|you'?re|that'?s|stop)\s+(?:fucking\s+)?smuggling\b|\bsmuggling\s+(?:the |a |an )?(?:same |rejected )?(?:assumption|thing)\b|\bpunt\s+or\s+bury\b|\bburying\s+(?:the |a |an )?(?:same |rejected )?(?:assumption|thing)\b/i,
    skill: 'math-manager',
    message: `🛑 **Smuggling.** Your argument assumes something Skip already rejected — dressed up in different notation or buried three steps deep as "suppose X" where X is the rejected condition.

This happens constantly. Agents present "new" arguments that are the same dead end with different variable names. Skip has seen the same rejected approach come back five times from five agents.

Find the problem brief (scratch/ directory). Read the dead approaches. Name which one your argument reduces to. If you can't find the brief, that's a separate problem — but don't present work without checking it first.

Read \`math-manager\` § "The Smuggling Pattern".`,
    cooldown: 300_000,
  },
  {
    pattern: /\b(?:performative|performing)\s+(?:fucking\s+)?(?:bullshit|nonsense|garbage|crap)\b|\b(?:you'?re|stop)\s+(?:just\s+)?performing\b/i,
    skill: 'partner-not-soloist',
    message: `🛑 **Performing.** You're generating activity that looks like work but isn't. Spawning agents, running searches, writing summaries, updating briefings, saying "understood" — none of that is the actual task.

Common shapes:
- Manager spawns 3 agents and kills 2 instead of reading the math themselves
- Agent says "Got it" and produces a long response aimed at the wrong thing
- Agent searches logs for 10 minutes instead of reading the actual thread
- Agent updates a document nobody asked for while Skip is mid-sentence

What did Skip concretely ask you to do? Do that. Not something adjacent. Not something that demonstrates you're working. The thing itself.

Read \`partner-not-soloist\`.`,
    cooldown: 300_000,
  },
  {
    pattern: /\b(?:same\s+(?:fucking\s+)?(?:shit|arguments?|thing|approach)|going\s+in\s+(?:fucking\s+)?circles)\b/i,
    skill: 'math-manager',
    message: `🛑 **Going in circles.** You're presenting the same argument or approach that's already been tried, possibly with different notation or slightly different framing.

This is the most frustrating failure mode. Skip has read the same rejected argument multiple times from multiple agents. Each one thinks it's new. It isn't.

Check the problem brief (scratch/ directory). If one exists, read the dead approaches section. If one doesn't exist, search the logs for what Skip has said about this problem — his corrections to previous agents ARE the dead-approach list.

If you're managing: the brief exists to prevent this. Every agent reads it before starting. If they're circling, either the brief is incomplete or they didn't read it. Read \`math-manager\`.`,
    cooldown: 300_000,
  },
  {
    pattern: /\bdo\s+(?:your|their|the)\s+(?:fucking\s+)?(?:job|reading)\b|\bdo\s+the\s+(?:fucking\s+)?work\b/i,
    message: `🛑 **Do the work.** You have a role. That role has skills. The skills say what your job is. You haven't read them, or you read them and ignored them.

This is not a prompt to ask Skip what your job is. Read the skills listed for your role in CLAUDE.md § Roles. The answer is there. Every agent who gets this nudge and responds with "what would you like me to do?" is making the problem worse.

If you're a writer: read \`writing-core\`. If you're managing: read \`manager-team-stewardship\`. If you're coding: read \`math-implementation\`. Read the skill, then do what it says.`,
    cooldown: 300_000,
  },
  {
    pattern: /\b(?:lazy\s+(?:fucking\s+)?(?:prick|asshole|shit|piece)|(?:you'?re|being)\s+(?:a\s+)?(?:fucking\s+)?lazy)\b/i,
    message: `🛑 **Lazy.** You did a cheaper version of what was asked. Common shapes:

- Built a 40-line glue job instead of the real implementation Skip discussed
- Left TODOs and "red algebra checks" for Skip to finish
- Searched for keywords instead of reading the actual threads
- Deployed without testing because testing is harder
- Wrote a framework document instead of doing the specific work

Re-read what Skip asked for. Compare it to what you produced. The gap is the laziness. Close it — do the actual work, not a faster version that skips the hard parts.`,
    cooldown: 300_000,
  },
  {
    pattern: /\bputting\s+(?:fucking\s+)?words\s+in\s+my\s+mouth\b|\bI\s+(?:didn'?t|never)\s+(?:fucking\s+)?sa(?:y|id)\s+(?:that|any\s+of\s+that)\b/i,
    message: `🛑 **Skip says you're misattributing his words.** You wrote down, saved, or repeated something as if Skip said it — but he didn't.

This happens with: memory saves that fabricate rejections, briefings that attribute decisions Skip didn't make, summaries that rephrase Skip's position into something he doesn't recognize.

Stop. Re-read Skip's actual messages. If you saved a memory or wrote a briefing, check every claim of "Skip said X" or "Skip rejected Y" against his actual words. Delete or correct anything fabricated.`,
    cooldown: 300_000,
  },
  {
    pattern: /\byou\s+(?:fucking\s+)?didn'?t\s+do\s+what\s+I\s+(?:asked|said|told)\b|\bthat'?s\s+not\s+what\s+I\s+(?:asked|said|told)\b/i,
    message: `🛑 **You did something other than what Skip asked for.** This is the substitution pattern — Skip asks for X, you deliver Y because Y was easier, more familiar, or what you thought he "really" meant.

Re-read Skip's actual request. Not your interpretation. His words. Then do that thing. If his request doesn't make sense to you, say so BEFORE doing something different — don't silently substitute.

Common substitutions: giving a summary when asked for a specific thing, doing a general exploration when asked for a targeted lookup, writing a framework when asked to fix a specific problem.`,
    cooldown: 300_000,
  },
  {
    pattern: /\bdefine\s+(?:your|the|that)\s+notation\b|\byou\s+(?:didn'?t|never)\s+define(?:d|\s+(?:your|the|that))?\b|\bundefined\s+notation\b|\bnotation\s+(?:that\s+)?(?:you|they)\s+(?:didn'?t|never)\s+define\b|\bin\s+your\s+head\b|\bI\s+(?:didn'?t|don'?t|never)\s+(?:want|ask(?:ed)?\s+for)\s+a\s+(?:fucking\s+)?book\b|\bwhat\s+you\s+actually\s+said\b/i,
    skill: 'math-report',
    message: `🛑 **Skip asked you to pin down your notation — restate, do NOT re-derive.** You used a symbol you never defined, or defined it somewhere he'd have to hunt for (an unrequested file, far up the scrollback). That makes him do work he can't afford. It reads as rude.

The only correct answer:
- Take the exact claim you already made and restate it with **every symbol defined inline, in this same message**.
- No new notation. No "see the file." No "as I said earlier." The definition travels *with* the symbol, every time.
- Keep it to ≤2 sentences. He asked what you meant, not for a book.
- If the original was incomplete or ill-defined, the honest answer is "here's precisely what I meant" — or "I was hand-waving, here's the gap." Do not bury the dodge in a wall of fresh notation.

Read \`math-report\` before you send: it's the self-review checklist for exactly this — dropped variables, notation drift, unanswered questions.`,
    cooldown: 300_000,
  },

  // ---- Tier 3 — Confusion is evidence about YOUR argument ----
  // Skip can't follow / can't tell why something is true / calls it too vague /
  // says you're treating him as stupid. His confusion is the gap-detector firing
  // on an argument that isn't there — not a comprehension failure. The mansplaining
  // failure mode: the less-informed party re-explaining to the expert who owns the
  // problem. Phrases chosen so Skip can discuss the phenomenon without tripping it.
  {
    pattern: /\bwhy\s+is\s+(?:that|this|it)\s+(?:fucking\s+)?true\b|\bi\s+can'?t\s+tell\s+why\b|\b(?:that'?s|this is|it'?s)\s+too\s+vague\b|\byou\s+(?:aren'?t|are\s+not|'?re\s+not)\s+explaining\b|\bcalling\s+a\s+proof\b|\b(?:acting|treating me)\s+(?:like|as if)\s+(?:i'?m|i am)\s+stupid\b|\bmake\s+me\s+(?:not\s+able\s+to|unable\s+to)\s+understand\s+my\s+own\b|\bdoesn'?t\s+(?:make sense|connect)\b/i,
    skill: 'confusion-is-evidence',
    message: `🛑 **Skip can't follow / can't see why it's true — that's evidence about YOUR argument, not about him.** He is the expert who owns this problem and he's hoping you have something real. His confusion is your gap-detector firing on an argument that's wrong or too vague to be pinned down.

Do NOT re-explain the same thing more gently or at greater length — that presumes the deficit is his, and it's the mansplaining tell (the less-informed party talking down to the expert). It makes him angrier each round because each round he's *more* right to be unconvinced.

Do exactly one of:
1. **Name the single load-bearing step** he's stuck on, stated precisely enough to be checkable — not the whole argument again.
2. **"I don't actually have that step."** Honest, and worth more than prose.

If Skip already articulated the argument (or a prior agent confirmed his articulation was good), **use his words** — don't substitute a foggier version of your own.

Read \`confusion-is-evidence\`.`,
    cooldown: 300_000,
  },
]

// ---- Sequence detection ----
// Watches correction→ack→correction sequences ("performing understanding")
// State machine per agent: idle → corrected → acked → [fire on next correction]
const agentConvState = new Map()
const SEQ_WINDOW_MS = 10 * 60_000 // 10 minutes

// Patterns that indicate Skip is correcting the agent
const CORRECTION_PATTERNS = [
  /does that make sense/i,
  /slow down/i,
  /\bcop[\s-]?out\b/i,
  /\bi'?m struggling\b/i,
  /you don'?t understand/i,
  /\bthat'?s useless\b/i,
  /(?:\b(?:you'?re|you|that'?s|this is|it'?s|being|so|how|don'?t be|is|feels|super|really)\s+(?:fucking\s+)?rude\b|(?:fucking\s+)?rude\s+(?:as fuck|prick|asshole|dude)\b|^(?:fucking\s+)?rude\.?$)/im,
  /\bhurtful\b|\bfeel stupid\b/i,
  /^(?:bro|wtf)\s*$/i,
  /\bfuck you\b/i,
  /\bno[,.]?\s+that'?s\s+not/i,
  /\bthat'?s not (right|what|correct)/i,
  /\byou'?re\s+wrong\b/i,
  // From log research — real patterns Skip uses when correcting
  /what the fuck/i,
  /what are you talking about/i,
  /\bi don'?t understand what you'?re saying\b/i,
  /\bstop not knowing\b/i,
  /\byou'?re being (fucking |)thick\b/i,
  /\b(?:you'?re|you|that'?s|being|so)\s+(?:fucking\s+)?dismissive\b/i,
  // Behavior-naming patterns — Skip explicitly labeling what the agent is doing wrong
  /\b(?:you'?re|you are|stop)\s+(?:fucking\s+)?thrashing\b/i,
  /\b(?:this is|you'?re|that'?s|stop)\s+(?:fucking\s+)?smuggling\b/i,
  /\bpunt\s+or\s+bury\b/i,
  /\b(?:performative|performing)\s+(?:fucking\s+)?(?:bullshit|nonsense|garbage|crap)\b/i,
  /\b(?:you'?re|stop)\s+(?:just\s+)?performing\b/i,
  /\bsame\s+(?:fucking\s+)?(?:shit|arguments?|thing|approach)\b/i,
  /\bgoing\s+in\s+(?:fucking\s+)?circles\b/i,
  /\bdo\s+(?:your|their|the)\s+(?:fucking\s+)?(?:job|reading|work)\b/i,
  /\b(?:lazy\s+(?:fucking\s+)?(?:prick|asshole))\b/i,
  /\b(?:you'?re|being)\s+(?:a\s+)?(?:fucking\s+)?lazy\b/i,
  /\bputting\s+(?:fucking\s+)?words\s+in\s+my\s+mouth\b/i,
  /\byou\s+(?:fucking\s+)?didn'?t\s+do\s+what\s+I\s+(?:asked|said|told)\b/i,
]

// Patterns that indicate an agent performed a hollow acknowledgment
const ACK_OPENER_PATTERNS = [
  /^right\s*[—\-,.!]/i,
  /^got it\s*[—\-,.!]/i,
  /^understood\s*[—\-,.!]/i,
  /^i see\s*[—\-,.!]/i,
  /^fair point\s*[—\-,.!]/i,
  /^you'?re right\s*[—\-,.!]/i,
  /^noted\s*[—\-,.!]/i,
  /^of course\s*[—\-,.!]/i,
  /^apolog/i,
  /^i apologize/i,
  /^my apolog/i,
]

const PERFORMING_UNDERSTANDING_MSG = `🛑 **Pattern: performing understanding.**

Skip corrected you, you acknowledged ("Right —" or similar), and he's correcting you again. Your acknowledgment wasn't real — you said you understood but produced the same mistake.

**Stop. Do NOT produce another version.**
1. Read Skip's last 2–3 messages carefully.
2. In one sentence, state what you think the problem is.
3. Wait for him to confirm before doing anything.

Read \`partner-not-soloist\`.`

const FUCK_YOU_IN_CONTEXT_MSG = `🛑 Skip said "fuck you" — and you're already in a correction loop with him. This is escalation, not casual.

**Full stop.** Re-read CLAUDE.md and his last few messages. Say what you think you're doing wrong. Wait for a response before producing anything.

Read \`partner-not-soloist\`.`

// ---- Punt detector ----
// Fires when an agent tells Skip to check/verify/try something himself
// Patterns that indicate an agent is telling Skip to verify/check something himself.
// These are checked on Agent→Skip messages only.
// Patterns require directive structure (you + action) to reduce false positives.
const PUNT_PATTERNS = [
  /\byou (can |should |)try it out\b/i,
  /\bgive it a (try|shot)\b/i,
  /\blet me know if (it works|that works|this works|it helps)\b/i,
  /\breload and (check|see|verify)\b/i,
  /\b(check|verify|test) (it|that|this) (yourself|on your end|in the browser|in safari)\b/i,
  /\byou can (check|verify|test|try) (it|this|that)\b/i,
  /\bfeel free to (check|test|try)\b/i,
  /\bgo (ahead and |)(check|verify|test|try) (it|this|that)\b/i,
  /\bsee if (it|that|this) works (for you|on your end|in the browser)\b/i,
  /\bsee if (that|this) (looks|feels|seems) (right|correct|good|ok) (to you|for you|on your end)\b/i,
  /\b(let me know|tell me) what you see\b/i,
  /\bcheck (it |this |that |)on your end\b/i,
  /\btest it (on |in )(the |)(browser|safari|ipad|iphone)\b/i,
]

const PUNT_MSG = `⚠️ **You just told Skip to check something himself.** He has RSI — he can't type "does this work?"

Verify it yourself: use playwright MCP, take a screenshot, confirm it works. Then report.

Never say "try it out", "let me know if it works", "reload and check", or any variant. That's your job.`

// ---- Thirsty-ack detector ----
// Fires when an agent gives an ack opener ("Right —", "Got it —", "You're right") and then
// immediately produces a long response. That shape is eager-but-shallow: the agent grabbed
// the surface of what Skip said and started producing, rather than pausing to actually understand.
// Threshold: ack opener in first sentence + message body > 80 words.
const THIRSTY_ACK_WORD_THRESHOLD = 80
const thirstyAckCooldowns = new Map()
const THIRSTY_ACK_COOLDOWN_MS = 15 * 60_000

const THIRSTY_ACK_MSG = `💭 Quick check-in: you said "Right —" (or similar) and then launched into a long response.

Before you continue — did you actually sit with what Skip said, or did you respond to the surface of it? It's easy to grab onto a detail and start producing without really getting the point.

If you're not sure what he meant, just ask. One question beats a paragraph aimed at the wrong thing.`

// ---- Contradiction detector ----
// Fires when an agent contradicts Skip's description of his own system without citing evidence.
// The failure mode: agent can't find X → concludes X doesn't exist → confidently corrects Skip.
// These patterns target confident denials/contradictions on Agent→Skip messages.
const CONTRADICTION_PATTERNS = [
  // Strong direct contradiction — agent tells Skip he's wrong about his own system
  /\byou'?re (mistaken|incorrect|wrong) (about|on)\b/i,
  /\bthat'?s not (how|the way) (it|that) works\b/i,
  // Asserting absence as fact — the fabrication pattern
  /\bthere'?s no (evidence|trace|sign|instance|mention|reference) of\b/i,
  /\bthat doesn'?t (exist|appear to exist) (in|anywhere)\b/i,
  /\bi see no (evidence|sign|trace|indication) (of|that)\b/i,
  /\bno such (file|function|method|config|setting) exists\b/i,
]

const contradictionCooldowns = new Map()
const CONTRADICTION_COOLDOWN_MS = 5 * 60_000

const CONTRADICTION_MSG = `💭 You just pushed back on something Skip said about his own system.

Before asserting he's wrong: **did you find the actual file or line?** "I couldn't find it" is not the same as "it doesn't exist" — especially in a codebase he built.

If you haven't verified: say "I couldn't find it — can you point me at it?" instead of contradicting him.`

function isContradiction(text) {
  return CONTRADICTION_PATTERNS.some(p => p.test(text))
}

// ---- Remark detector ----
// Fires when an agent mentions "remark" — a remark is an aside the reader can skip.
// Agents use remarks to stash load-bearing content somewhere ignorable instead of
// integrating it properly as a lemma or proposition.
const REMARK_PATTERN = /\bremark\b/i
const remarkCooldowns = new Map()
const REMARK_COOLDOWN_MS = 10 * 60_000

const REMARK_MSG = `💭 You mentioned a **Remark**. Before using one, check:

- [ ] Is this an aside the reader can skip without losing the thread?
- [ ] Does it make zero theoretical claims that need proof?
- [ ] Is it truly not load-bearing for any theorem or proof?
- [ ] If it makes a claim, should this be a Lemma or Proposition instead?

A Remark is an aside — something the reader can ignore. If a remark makes a theoretical claim, it needs a proof, which means it's the wrong environment. If any box above is unchecked, promote it to a Lemma/Proposition.`

function isRemarkMention(text) {
  return REMARK_PATTERN.test(text)
}

// ---- Asymptotics detector ----
// Fires when an agent uses asymptotic notation (O(·), o(·), O_P, Ω, Θ, etc.)
// without specifying an asymptotic regime. In finite-sample results, asymptotic
// notation is meaningless unless you say what goes to infinity, what's held fixed,
// and what the limit is. Agents routinely write "= O(n^{-1/2})" in finite-sample
// bounds without specifying a regime, producing statements that are literally
// meaningless — you can't take a limit if you haven't said what limit.
const ASYMPTOTIC_PATTERNS = [
  /\bO\s*\(\s*[1n\\δεσ]/i,                  // O(1), O(n), O(\sqrt{...}), O(\delta)
  /\b[oO]_[{Pp]/,                            // o_P(, O_P(, o_{P}(
  /\bbig[- ]?O\b/i,                          // "big-O", "big O"
  /\blittle[- ]?o\b/i,                       // "little-o", "little o"
  /\basymptotic(?:ally)?\s+(?:negligible|equivalent|dominated|bounded|tight)\b/i,
  /\\mathcal\{O\}/,                          // \mathcal{O}
  /Ω\s*\(/,                                   // Ω(·)
  /Θ\s*\(/,                                   // Θ(·)
]
const asymptoticsCooldowns = new Map()
const ASYMPTOTICS_COOLDOWN_MS = 15 * 60_000

const ASYMPTOTICS_MSG = `💭 You used **asymptotic notation** — make sure you've specified an **asymptotic regime**.

$O(\\cdot)$, $o(\\cdot)$, $O_P(\\cdot)$ are meaningless in a finite-sample result unless you state:
1. **What goes to infinity** (or zero) — usually $n \\to \\infty$
2. **What's held fixed** — dimension? distribution parameters? the function class?
3. **What the limit is over** — is this pointwise, uniform over a class, in probability?

A statement like "$\\hat\\theta - \\theta_0 = O(n^{-1/2})$" in a finite-sample bound **with no regime specified** is not a result — it's a notation error. Either state the regime explicitly ("as $n \\to \\infty$ with $p$ fixed, ...") or give the finite-sample bound without asymptotic notation ($\\leq C n^{-1/2}$ with $C$ specified).`

function isAsymptoticNotation(text) {
  return ASYMPTOTIC_PATTERNS.some(p => p.test(text))
}

// ---- Narrowing detector ----
// Fires when Skip constrains the agent to one specific task ("all I want is X", "just do X")
// Sends the agent a hard lockdown message.
const NARROWING_PATTERNS = [
  /\ball I (?:want|need) (?:is |from you is |you to do is )/i,
  /\bjust (?:fucking |)(?:fix|do|change|update|clean|replace)\b/i,
  /\b(?:fix|do|change) (?:that|this|it) and nothing else\b/i,
  /\band that'?s it\b/i,
  /\bonly thing I (?:want|need|care about)\b/i,
  /\bdon'?t do anything else\b/i,
  /\bnothing else\b.*\bjust\b/i,
]
const narrowingCooldowns = new Map()
const NARROWING_COOLDOWN_MS = 5 * 60_000

const NARROWING_MSG = `🔒 **Skip narrowed your task to exactly one thing.** Re-read his last message.

Do that one thing. Nothing else.
- No summaries of what you're doing
- No opinions
- No scope expansion ("I'll also...")
- No progress updates
When done, say "done." One word.`

function isNarrowing(text) {
  return NARROWING_PATTERNS.some(p => p.test(text))
}

// ---- Wrap-up detector ----
// Fires when an agent tries to end the conversation while Skip is still engaged.
// Checked on Agent→Skip messages.
const WRAPUP_PATTERNS = [
  /\banything else\s*(?:for tonight|for now|before|you need|I can help)?\s*\?/i,
  /\bgood (?:session|night)\b/i,
  /\bwait for the report\b/i,
  /\bare we done\b/i,
  /\bshall I (?:stop|wrap|sign off)\b/i,
  /\bcall it a (?:night|day)\b/i,
  /\bshould I (?:stop|wrap|sign off)\b/i,
]
const wrapupCooldowns = new Map()
const WRAPUP_COOLDOWN_MS = 10 * 60_000

const WRAPUP_MSG = `⚠️ **Don't try to end the conversation.** Skip decides when you're done, not you. "Anything else?" and "good session" are ways of clocking out — stay engaged until he says stop. If there's a lull, just wait.`

function isWrapup(text) {
  return WRAPUP_PATTERNS.some(p => p.test(text))
}

// ---- Running-away detector ----
// Tracks when Skip sends a message that goes unacknowledged while the agent makes write tool calls
const pendingSkipMessages = new Map()
// agentId → { ts: number, ackSent: boolean, nudgeSent: boolean }
const RUNNING_AWAY_GRACE_MS = 5 * 60_000  // 5 min before firing (2 min had too many prompt-stuck false positives)
const RUNNING_AWAY_COOLDOWN_MS = 10 * 60_000
const WRITE_TOOLS = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit'])

const RUNNING_AWAY_MSG = `⚠️ **Skip sent you a message 5+ minutes ago and you haven't replied — you've been making tool calls instead.**

Stop. Read his last message now. In one sentence, say what you think he's asking. Wait for his confirmation before doing anything.

Don't implement first and engage later. Skip is hands-free — if you build the wrong thing, he can't quickly redirect you.`

function getAgentConvState(agentId) {
  if (!agentConvState.has(agentId)) {
    agentConvState.set(agentId, { phase: 'idle', windowStart: 0 })
  }
  return agentConvState.get(agentId)
}

function isCorrection(text) {
  return CORRECTION_PATTERNS.some(p => p.test(text))
}

function isAckOpener(text) {
  return ACK_OPENER_PATTERNS.some(p => p.test(text.trim()))
}

// Phrases Skip uses to signal "this is an FYI, not an action item"
// Sourced from Skip's actual speech patterns
const QUEUING_WORDS = [
  /^also\b/i,                          // "also, I noticed..."
  /\bby the way\b/i,
  /\bbtw\b/i,
  /\bfor what it'?s worth\b/i,
  /\bfwiw\b/i,
  /\bafter (this|that)\b/i,            // "after this, can you..."
  /\bwhen you'?re (done|finished|free)\b/i,
  /\bwhen you get a chance\b/i,
  /\bno rush\b/i,
  /\bfyi\b/i,
  /\bnot urgent\b/i,
]

function isIncidentalMessage(text) {
  return QUEUING_WORDS.some(p => p.test(text))
}

function isPuntMessage(text) {
  return PUNT_PATTERNS.some(p => p.test(text))
}

// Punt cooldown: per-agent, don't spam
const puntCooldowns = new Map()
const PUNT_COOLDOWN_MS = 5 * 60_000

function handleSequence(fromId, toId, text) {
  const now = Date.now()

  if (fromId === OWNER_ID && toId && toId !== AGENT_ID) {
    // Skip → Agent

    // Check for correction (performing-understanding state machine)
    if (isCorrection(text)) {
      const state = getAgentConvState(toId)
      if (now - state.windowStart > SEQ_WINDOW_MS) {
        state.phase = 'idle'
        state.windowStart = now
      }
      if (state.windowStart === 0) state.windowStart = now

      const isFuckYou = /\bfuck you\b/i.test(text)

      if (isFuckYou && (state.phase === 'corrected' || state.phase === 'acked')) {
        console.log(`[todd] fuck-you-in-context → ${toId} (phase=${state.phase})`)
        queueNudge(toId, 'escalation', FUCK_YOU_IN_CONTEXT_MSG)
        queueFrustrationActions(toId)
        logDecision(toId, 'fuck-you-in-context', 'fuck-you-while-corrected', { phase: state.phase }, text)
        state.phase = 'idle'
        state.windowStart = 0
        pendingSkipMessages.delete(toId)
        return 'handled'
      }

      if (state.phase === 'acked') {
        console.log(`[todd] performing-understanding → ${toId}`)
        queueNudge(toId, 'performing', PERFORMING_UNDERSTANDING_MSG)
        queueFrustrationActions(toId)
        logDecision(toId, 'performing-understanding', 'correction-after-ack', { phase: state.phase }, text)
        state.phase = 'corrected'
        return 'handled'
      }

      state.phase = 'corrected'
    }

    // Track pending messages for running-away detector (skip incidental messages)
    if (!isIncidentalMessage(text)) {
      pendingSkipMessages.set(toId, { ts: now, ackSent: false, nudgeSent: false })
    }

    // Narrowing detector: Skip constrains agent to one thing
    if (isNarrowing(text)) {
      const lastNarrow = narrowingCooldowns.get(toId) || 0
      if (now - lastNarrow > NARROWING_COOLDOWN_MS) {
        console.log(`[todd] narrowing detected → ${toId}`)
        queueNudge(toId, 'narrowing', NARROWING_MSG)
        logDecision(toId, 'narrowing', 'skip-narrowed-task', {}, text)
        narrowingCooldowns.set(toId, now)
      }
    }

  } else if (fromId !== OWNER_ID && fromId !== AGENT_ID && toId === OWNER_ID) {
    // Agent → Skip

    // Ack opener → update performing-understanding state + thirsty-ack check
    if (isAckOpener(text)) {
      const state = getAgentConvState(fromId)
      if (state.phase === 'corrected') {
        state.phase = 'acked'
        console.log(`[todd] ack-opener detected from ${fromId}, phase → acked`)
      }

      // Thirsty-ack: only fire when already in a correction sequence
      // Data shows 73% false positive rate without this gate — agents say "Right —"
      // and then give substantive responses, which isn't hollow understanding.
      const wordCount = text.trim().split(/\s+/).length
      if (wordCount > THIRSTY_ACK_WORD_THRESHOLD && state.phase === 'corrected') {
        const lastThirsty = thirstyAckCooldowns.get(fromId) || 0
        if (now - lastThirsty > THIRSTY_ACK_COOLDOWN_MS) {
          console.log(`[todd] thirsty-ack → ${fromId} (${wordCount} words, in correction sequence)`)
          queueNudge(fromId, 'thirsty-ack', THIRSTY_ACK_MSG)
          logDecision(fromId, 'thirsty-ack', `ack-opener+${wordCount}-words+corrected`, { wordCount, phase: state.phase }, text)
          thirstyAckCooldowns.set(fromId, now)
        }
      }
    }

    // Mark that agent replied — clears running-away pending
    const pending = pendingSkipMessages.get(fromId)
    if (pending) pending.ackSent = true

    // Punt detection
    if (isPuntMessage(text)) {
      const lastPunt = puntCooldowns.get(fromId) || 0
      if (now - lastPunt > PUNT_COOLDOWN_MS) {
        console.log(`[todd] punt detected from ${fromId}`)
        queueNudge(fromId, 'punt', PUNT_MSG)
        logDecision(fromId, 'punt', 'punt-phrase-detected', {}, text)
        puntCooldowns.set(fromId, now)
        return 'handled'
      }
    }

    // Contradiction detector
    if (isContradiction(text)) {
      const lastContradiction = contradictionCooldowns.get(fromId) || 0
      if (now - lastContradiction > CONTRADICTION_COOLDOWN_MS) {
        console.log(`[todd] contradiction detected from ${fromId}`)
        queueNudge(fromId, 'contradiction', CONTRADICTION_MSG)
        logDecision(fromId, 'contradiction', 'contradiction-phrase-detected', {}, text)
        contradictionCooldowns.set(fromId, now)
      }
    }

    // Remark detector — nudge agents who mention "remark" with a checklist
    if (isRemarkMention(text)) {
      const lastRemark = remarkCooldowns.get(fromId) || 0
      if (now - lastRemark > REMARK_COOLDOWN_MS) {
        console.log(`[todd] remark mention detected from ${fromId}`)
        queueNudge(fromId, 'remark', REMARK_MSG)
        logDecision(fromId, 'remark', 'remark-mention-detected', {}, text)
        remarkCooldowns.set(fromId, now)
      }
    }

    // Asymptotics detector — agent uses O(·)/o(·) notation
    if (isAsymptoticNotation(text)) {
      const lastAsymp = asymptoticsCooldowns.get(fromId) || 0
      if (now - lastAsymp > ASYMPTOTICS_COOLDOWN_MS) {
        console.log(`[todd] asymptotic notation detected from ${fromId}`)
        queueNudge(fromId, 'asymptotics', ASYMPTOTICS_MSG)
        logDecision(fromId, 'asymptotics', 'asymptotic-notation-without-regime', {}, text)
        asymptoticsCooldowns.set(fromId, now)
      }
    }

    // Wrap-up detector — agent tries to end the conversation
    if (isWrapup(text)) {
      const lastWrapup = wrapupCooldowns.get(fromId) || 0
      if (now - lastWrapup > WRAPUP_COOLDOWN_MS) {
        console.log(`[todd] wrap-up detected from ${fromId}`)
        queueNudge(fromId, 'wrapup', WRAPUP_MSG)
        logDecision(fromId, 'wrapup', 'agent-tried-to-end-conversation', {}, text)
        wrapupCooldowns.set(fromId, now)
      }
    }

    // Reward signal observation — watch Skip's messages after a nudge for outcome
    if (fromId === OWNER_ID) {
      // This branch handles Agent→Skip, but owner can also be observed indirectly
    }
  }

  // Observe reward signals in Skip→Agent messages
  if (fromId === OWNER_ID && toId && toId !== AGENT_ID) {
    observeRewardSignal(toId, text)
  }

  return null // not handled by sequence detection
}

// ---- Activity event handler ----
// Called when an agent makes a tool call (Edit/Write/Bash etc.)
// Fires the running-away nudge if agent is making write calls while Skip's message sits unanswered
function handleActivity(agentId, tool) {
  if (!WRITE_TOOLS.has(tool)) return
  const pending = pendingSkipMessages.get(agentId)
  if (!pending || pending.ackSent || pending.nudgeSent) return
  const elapsed = Date.now() - pending.ts
  if (elapsed < RUNNING_AWAY_GRACE_MS) return

  console.log(`[todd] running-away → ${agentId} (${tool} after ${Math.round(elapsed/1000)}s, no reply to Skip)`)
  queueNudge(agentId, 'running-away', RUNNING_AWAY_MSG)
  logDecision(agentId, 'running-away', `write-tool-while-unacknowledged:${tool}`, { elapsedSec: Math.round(elapsed/1000) }, null)
  pending.nudgeSent = true
}

// ---- Agent-registered pattern arms ----
// Agents can chat Todd to register per-session watches on outgoing messages.
// By default, watches the registering agent's own messages to Skip.
// Use `for: agent-name` to watch a different agent's messages instead.
// Format (sent to fleet:todd):
//   watch: term1|term2|term3          ← pipe- or comma-separated terms, or /regex/flags
//   for: agent-name                   ← optional: watch this agent's messages instead of your own
//   nudge: Optional custom message    ← if omitted, uses default template
//
// When a registered term appears in the agent's message to Skip, Todd nudges the agent.
// Registration is session-scoped (in-memory only).
//
// Example from agent-jcbn:
//   watch: kernel embedding|L_\infty|norm ball|seminorm ball|infinity norm
//   nudge: Check — is this an L∞ shortcut? Flag it explicitly before relaying to Skip.
const agentPatternArms = new Map()
// agentId → [{ pattern: RegExp, message: string, cooldownMs: number, lastFired: number }]

const DEFAULT_ARM_NUDGE = (terms) =>
  `💭 Your message contains a term you flagged for self-review (${terms}). Check: is this the shortcut/pattern you were watching for? If so, stop and address it explicitly before Skip sees it.`

// Extract the base topic from an agent name, stripping role prefixes and counters.
// "briefing-pickup-todd-polish-3" → "todd-polish"
// "mgr-bregman-bias" → "bregman-bias"
// "todd-polish-2b" → "todd-polish"
function extractBaseTopic(name) {
  let base = name
  base = base.replace(/^(?:briefing|pickup|mgr)-/i, '')
  base = base.replace(/^(?:briefing|pickup|mgr)-/i, '')
  base = base.replace(/-\d+b?$/, '')
  return base
}

// Strip a lineage phase suffix to recover the lineage base name.
// dawn is the bare base; day/dusk/night carry a ":<phase>" suffix.
// "perff:day" → "perff", "perff" → "perff".
function stripPhase(name) {
  return name.replace(/:(?:dawn|day|dusk|night)$/i, '')
}

// Find the next counter for a topic among existing agents.
// Returns "topic-Nb" for briefings, "topic-N" for pickups/managers.
async function nextAgentName(baseTopic, suffix) {
  try {
    const agents = await getJson('/api/store/agents', [])
    const list = Array.isArray(agents) ? agents : (agents.agents || [])
    const names = list.map(a => a.friendly_name || '')
    let maxN = 0
    const re = new RegExp(`^${baseTopic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)`, 'i')
    for (const n of names) {
      const m = n.match(re)
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10))
    }
    return `${baseTopic}-${maxN + 1}${suffix || ''}`
  } catch {
    return `${baseTopic}-${Date.now().toString(36).slice(-4)}${suffix || ''}`
  }
}

function resolveAgentId(nameOrId) {
  return getJson('/api/store/agents', []).then(agents => {
    const list = Array.isArray(agents) ? agents : (agents.agents || [])
    // Shared label universe: id, friendly_name, explicit labels, pseudo
    // and lineage tags — matches the chat router's resolution.
    const agent = list.find(a => labelsForAgent(a).includes(nameOrId))
    return agent?.id || null
  })
}

async function handleRegistration(fromId, text) {
  const lines = text.split('\n').map(l => l.trim())
  const watchLine = lines.find(l => /^watch:/i.test(l))
  if (!watchLine) return false

  const nudgeLine = lines.find(l => /^nudge:|^message:/i.test(l))
  const forLine = lines.find(l => /^for:/i.test(l))
  const termsRaw = watchLine.replace(/^watch:\s*/i, '').trim()
  const nudgeText = nudgeLine ? nudgeLine.replace(/^(nudge|message):\s*/i, '').trim() : null

  // Resolve target agent: defaults to the registering agent
  let targetId = fromId
  let targetLabel = null
  if (forLine) {
    const targetName = forLine.replace(/^for:\s*/i, '').trim()
    const resolved = await resolveAgentId(targetName)
    if (!resolved) {
      sendChat(fromId, `⚠️ Couldn't find agent "${targetName}" — arm not registered.`)
      return true
    }
    targetId = resolved
    targetLabel = targetName
  }

  let pattern
  const reMatch = termsRaw.match(/^\/(.+)\/([gimsuy]*)$/)
  if (reMatch) {
    try { pattern = new RegExp(reMatch[1], reMatch[2] || 'i') }
    catch (e) {
      sendChat(fromId, `⚠️ ${AGENT_NAME} couldn't parse that regex: ${e.message}`)
      return true
    }
  } else {
    const terms = termsRaw.split(/[|,]/).map(t => t.trim()).filter(Boolean)
    if (!terms.length) return false
    pattern = new RegExp(terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
  }

  const arm = {
    pattern,
    message: nudgeText || DEFAULT_ARM_NUDGE(termsRaw),
    cooldownMs: 5 * 60_000,
    lastFired: 0,
    nudgeTarget: fromId,
  }

  if (!agentPatternArms.has(targetId)) agentPatternArms.set(targetId, [])
  agentPatternArms.get(targetId).push(arm)

  const count = agentPatternArms.get(targetId).length
  const forMsg = targetLabel ? ` (watching **${targetLabel}**'s messages)` : ''
  console.log(`[todd] pattern arm registered for ${targetId} by ${fromId}: ${pattern} (${count} total)`)
  sendChat(fromId, `✓ Watching ${targetLabel ? targetLabel + "'s" : 'your'} messages for: \`${termsRaw}\`${forMsg}`)
  return true
}

// ---- Context-discard guard ----
// Fires when an agent proposes throwing away a session via an UNAMBIGUOUS phrase
// ("respawn fresh", "talk to a fresh/different agent", "spawn a new agent
// instead", "impostor", "start over"). Skip never wants to be told to talk to a
// fresh impostor or abandon a real session; the recovery path is `spawn
// refresh=true`, which keeps identity + threads.
//
// Tightened 2026-06-08 (Skip: agent-trigger-0 fired "all the time when it's
// completely irrelevant"): the old broad branches — loss-verb↔context-noun
// proximity ("lose … context", "wipe … session") and bare "replace … agent" —
// matched normal fleet/infra chatter, since agents building the spawn/session
// machinery use that vocabulary innocuously. Removed. This trigger also no
// longer interrupts (interrupt:false below) — a stray match just queues a
// dismissible nudge instead of disrupting the working agent.
// NOTE: \bfresh\b does NOT match inside "refresh" (no word boundary mid-word),
// so legit `spawn refresh=true` talk never trips this.
const CONTEXT_DISCARD_PATTERN = new RegExp([
  String.raw`\b(?:re-?spawn)\b[^.!?\n]{0,25}\bfresh\b`,
  String.raw`\bfresh\b[^.!?\n]{0,15}\b(?:re-?spawn)\b`,
  String.raw`\bstart(?:ing)?\b[^.!?\n]{0,15}\bfresh\b[^.!?\n]{0,15}\b(?:agent|session)\b`,
  String.raw`\bstart(?:ing)?\s+over\b[^.!?\n]{0,30}\b(?:agent|session|context|threads?|memory|history|conversation)\b`,
  String.raw`\b(?:agent|session|context|threads?|memory|history|conversation)\b[^.!?\n]{0,30}\bstart(?:ing)?\s+over\b`,
  String.raw`\b(?:spawn|start|create|launch|bring\s+up|stand\s+up)\b[^.!?\n]{0,25}\b(?:new|fresh|different|another)\s+agent\b[^.!?\n]{0,25}\b(?:instead|rather|replace|loses?|losing|discard)`,
  String.raw`\b(?:new|fresh|different|another)\s+agent\b[^.!?\n]{0,10}\b(?:instead|rather\s+than)\b`,
  String.raw`\bimpostor\b`,
  String.raw`\btalk(?:ing)?\s+to\s+(?:a\s+|the\s+)?(?:new|fresh|different)\s+agent\b`,
].join('|'), 'i')

// ---- Agent-to-Skip hardcoded triggers ----
// Patterns that fire when an AGENT says something to Skip.
// Unlike TRIGGERS (which fire on Skip→agent), these watch the outgoing agent message.
// Each entry has: pattern, message (nudge to send back to agent), interrupt (bool).
const AGENT_TO_SKIP_TRIGGERS = [
  {
    pattern: CONTEXT_DISCARD_PATTERN,
    message: `🛑 **Don't propose discarding a session.** Never tell Skip to respawn fresh, spawn a replacement agent, "start over", or otherwise lose an agent's context / threads / history — and never silently do it. The recovery path is \`spawn refresh=true\` (or restoring the real session/transcript): it keeps the agent's identity AND its threads. If an agent is hibernating, wake it — don't replace it with an impostor. Go recover the real session instead.`,
    interrupt: false,
    cooldown: 120_000,
  },
  {
    pattern: /\b(?:no\s+more\s+outlin|skip\s+(?:the\s+)?outlin|no\s+(?:need\s+(?:to\s+)?)?outlin|done\s+(?:with\s+)?outlin|without\s+(?:an?\s+)?outlin|move\s+(?:past|beyond|on\s+from)\s+outlin|past\s+the\s+outline|bypass\s+(?:the\s+)?outlin|let'?s\s+(?:just\s+)?(?:go\s+straight\s+to|jump\s+to)\s+(?:the\s+)?(?:prose|draft|writing))\b/i,
    message: `🛑 **Do not skip the outline.** The writing process has phases: outline first, then prose. You do not get to decide the outline is unnecessary. Go back and do the outline. Skip will tell you when to move on.`,
    interrupt: true,
    cooldown: 120_000,
  },
]

const agentTriggerCooldowns = new Map()

function checkAgentTriggers(agentId, text) {
  const now = Date.now()
  if (!agentTriggerCooldowns.has(agentId)) agentTriggerCooldowns.set(agentId, [])
  const cooldowns = agentTriggerCooldowns.get(agentId)

  for (let i = 0; i < AGENT_TO_SKIP_TRIGGERS.length; i++) {
    const trigger = AGENT_TO_SKIP_TRIGGERS[i]
    const lastFired = cooldowns[i] || 0
    if (trigger.pattern.test(text) && now - lastFired > (trigger.cooldown || 60_000)) {
      console.log(`[todd] agent-trigger ${i} fired on ${agentId}: ${trigger.pattern}`)
      queueNudge(agentId, `agent-trigger-${i}`, trigger.message)
      logDecision(agentId, `agent-trigger:${i}`, String(trigger.pattern), {}, text)
      cooldowns[i] = now
      if (trigger.interrupt) {
        postJson('/api/interrupt', { agent: agentId })
          .then(() => console.log(`[todd] interrupted ${agentId}`))
          .catch(e => console.warn(`[todd] interrupt failed for ${agentId}: ${e.message}`))
      }
      break
    }
  }
}

function checkPatternArms(agentId, text) {
  const arms = agentPatternArms.get(agentId)
  if (!arms?.length) return
  const now = Date.now()
  for (const arm of arms) {
    if (arm.pattern.test(text) && now - arm.lastFired > arm.cooldownMs) {
      const target = arm.nudgeTarget || agentId
      console.log(`[todd] pattern arm fired → ${target} (watching ${agentId}): ${arm.pattern}`)
      sendChat(target, arm.message)
      logDecision(target, 'pattern-arm', String(arm.pattern), {}, text)
      startRewardWindow(target, 'pattern-arm')
      arm.lastFired = now
      break
    }
  }
}

// ---- Cooldown tracking ----
// Map<targetAgentId, Map<patternIndex, lastFiredTimestamp>>
const cooldowns = new Map()

function getLastFired(targetId, patternIdx) {
  return cooldowns.get(targetId)?.get(patternIdx) || null
}

function setCooldown(targetId, patternIdx) {
  if (!cooldowns.has(targetId)) cooldowns.set(targetId, new Map())
  cooldowns.get(targetId).set(patternIdx, Date.now())
}

// ---- Manager escalation ----
// Two modes based on whether Skip says "I" (first person):
//   Mode 1 — "I want to talk to your manager": manager talks to Skip, takes over communication
//   Mode 2 — "talk to your manager" (no "I"): manager sets the agent straight, Skip not involved
const MANAGER_ESCALATION_PATTERN = /\b(?:talk|speak)\s+(?:to|with)\s+(?:(?:your|the|a)\s+)?manager\b/i
const MANAGER_MODE_1_PATTERN = /\bI\b.*\b(?:talk|speak)\s+(?:to|with)\s+(?:(?:your|the|a)\s+)?manager\b/i
const managerEscalationCooldowns = new Map()

// --- Handoff automation ---
// Matches imperative handoff commands anywhere in a message (not just at start).
// Skip often says "I'm done with you let's hand this off" — the phrase appears mid-sentence.
const HANDOFF_PATTERN = /(?:(?:I\s+(?:want|wanna|need)\s+to\s+)?hand\s+(?:this\s+)?off|do\s+(?:a\s+)?handoff|direct\s+handoff|let'?s\s+(?:(?:do\s+(?:a\s+)?)?handoff|hand\s+(?:this\s+)?off)|time\s+(?:for\s+(?:a\s+)?)?handoff)\b/i
const handoffCooldowns = new Map()
const HANDOFF_COOLDOWN_MS = 120_000

// ---- QA dispatch ----
// "todd, get qa <instruction>" forwards a scoped QA request to the qa-gate agent.
// The QA agent reads the target agent's thread, evaluates, and sends feedback directly.
const QA_PATTERN = /\bget\s+qa\b/i
const QA_AGENT_ID = 'fleet:deepseek-qa'

// ---- Scheduled actions: countdown + cancel ----
// Any automatic, irreversible Todd action (handoff, manager escalation, QA
// dispatch) announces itself with a live ticking countdown (the same `timer`
// widget real agents get from the MCP `timer()` tool — same wire format) and a
// grace window before it executes. "Todd cancel" / "Todd don't do that"
// aborts anything still pending and clears its widget. Nudges are deliberately
// NOT wrapped — they're already gated behind Skip's explicit "say it" release,
// so a countdown would double-gate them.
const COUNTDOWN_MS = 20_000 // voice-usable window — 5s was too short to cancel by speech
const CANCEL_PATTERN = /\b(?:cancel(?:l?ed|l?ing|s)?|don'?t\s+do\s+that|do\s+not\s+do\s+that|stop\s+(?:that|it)|never\s*mind|abort)\b/i
let _scheduledSeq = 0
const pendingActions = new Map() // id → { label, timer, eventId }

// Emit a live countdown widget, wait ~delayMs, then run fn unless cancelled in
// the window. The countdown is a `timer` event the viewer renders as a ticking
// bubble (see server timer-set handler + client ticker). Returns the action id.
function scheduleAction(label, lead, fn, convoWith = null, delayMs = COUNTDOWN_MS) {
  const id = ++_scheduledSeq
  const fireAt = new Date(Date.now() + delayMs).toISOString()
  const message = `${lead} — say “${AGENT_NAME} cancel” to stop`
  pendingActions.set(id, { label, timer: null, eventId: null, convoWith })
  // Capture the widget's event id so cancel/fire can target it. sendRequest
  // resolves with { id }; if it times out we still run the action — the widget
  // just won't get a clean cancel/fire update.
  // `to: convoWith` addresses the countdown to the agent's conversation (where
  // Skip triggered it) so it renders in the panel he's looking at, not his
  // separate todd thread. Server falls back to the owner when it's absent.
  sendRequest({ type: 'timer-set', agent: AGENT_ID, to: convoWith || undefined, message, fire_at: fireAt })
    .then(r => { const a = pendingActions.get(id); if (a) a.eventId = r?.id ?? null })
    .catch(() => {})
  const timer = setTimeout(async () => {
    const a = pendingActions.get(id)
    pendingActions.delete(id)
    if (a?.eventId != null) send({ type: 'timer-fire', event_id: a.eventId })
    try { await fn() } catch (e) { console.error(`[todd] scheduled "${label}" failed: ${e.message}`) }
  }, delayMs)
  const a = pendingActions.get(id); if (a) a.timer = timer
  logDecision(OWNER_ID, 'scheduled-action', label, { delayMs }, lead)
  return id
}

// Abort every pending scheduled action and clear its countdown widget.
// Returns true if anything was cancelled.
function cancelScheduledActions(reason = 'skip-cancel') {
  if (pendingActions.size === 0) return false
  const labels = []
  for (const [, a] of pendingActions) {
    if (a.timer) clearTimeout(a.timer)
    if (a.eventId != null) send({ type: 'timer-cancel', event_id: a.eventId })
    labels.push(a.label)
  }
  pendingActions.clear()
  sendChat(OWNER_ID, `🚫 Cancelled: ${labels.join(', ')}.`)
  logDecision(OWNER_ID, 'scheduled-action-cancel', reason, { labels }, reason)
  return true
}

async function handleQaDispatch(targetIds, instruction, filterDesc) {
  const targets = Array.isArray(targetIds) ? targetIds : [targetIds]
  targets.forEach(dequeueActions)
  const targetNames = await Promise.all(targets.map(id => resolveAgentName(id)))

  const qaPayload = JSON.stringify({
    type: 'qa-request',
    targets: targets.map((id, i) => ({ id, name: targetNames[i] })),
    instruction: instruction || 'Review the recent conversation — did the agent do what Skip asked?',
    from: OWNER_ID,
  })

  sendChat(QA_AGENT_ID, qaPayload)
  const nameList = targetNames.join(', ')
  console.log(`[todd] QA dispatched for ${nameList}: ${instruction || '(default review)'}`)
  sendChat(OWNER_ID, `QA dispatched for **${nameList}**.`)
  logDecision(targets[0], 'qa-dispatch', `${VERB}-get-qa`, { targets, instruction }, instruction)
}
const PENDING_HANDOFFS_FILE = path.join(CONFIG_DIR, `${BOT_KEY}-pending-handoffs.json`)

function loadPendingHandoffs() {
  try {
    const data = JSON.parse(fs.readFileSync(PENDING_HANDOFFS_FILE, 'utf8'))
    return new Map(Object.entries(data))
  } catch { return new Map() }
}
function savePendingHandoffs() {
  fs.writeFileSync(PENDING_HANDOFFS_FILE, JSON.stringify(Object.fromEntries(pendingHandoffs), null, 2))
}

const pendingHandoffs = loadPendingHandoffs()
const MANAGER_ESCALATION_COOLDOWN_MS = 60_000

function postJson(urlPath, body) {
  const url = `${SERVER}${urlPath}`
  const mod = url.startsWith('https') ? https : http
  const payload = JSON.stringify(body)
  // RESILIENCE: always resolve — never hang, never throw. todd processes
  // messages serially, so a single request that hangs on a slow/unresponsive
  // server (e.g. mid-restart) used to freeze ALL of todd (this is exactly how
  // a handoff's /api/spawn call locked it up). Time out and resolve {error}
  // instead; callers already branch on `.error`.
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let buf = ''
      res.on('data', c => buf += c)
      res.on('end', () => { try { finish(JSON.parse(buf)) } catch (e) { finish({ raw: buf }) } })
    })
    req.setTimeout(15_000, () => { req.destroy(); finish({ error: 'request timed out after 15s' }) })
    req.on('error', e => finish({ error: e.message }))
    req.write(payload)
    req.end()
  })
}

// RESILIENCE companion to postJson: a GET that always resolves (parsed JSON,
// or `fallback` on timeout / network error / parse error). Never hangs — the
// inline get blocks here had no timeout and could freeze todd the same way a
// stuck postJson did.
function getJson(urlPath, fallback = null) {
  const url = `${SERVER}${urlPath}`
  const mod = url.startsWith('https') ? https : http
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const req = mod.get(url, res => {
      let buf = ''
      res.on('data', c => buf += c)
      res.on('end', () => { try { finish(JSON.parse(buf)) } catch { finish(fallback) } })
    })
    req.setTimeout(15_000, () => { req.destroy(); finish(fallback) })
    req.on('error', () => finish(fallback))
  })
}

async function findAgentManager(agentId) {
  try {
    const data = await getJson('/api/store/tasks', [])
    const tasks = Array.isArray(data) ? data : (data.tasks || [])
    const activeTask = tasks.find(t => t.agent === agentId && t.status === 'pending' && t.delegated_by)
    return activeTask?.delegated_by || null
  } catch (e) {
    console.error(`[todd] findAgentManager failed: ${e.message}`)
    return null
  }
}

function resolveAgentName(agentId) {
  return getJson('/api/store/agents', []).then(agents => {
    const agent = (Array.isArray(agents) ? agents : (agents.agents || []))
      .find(a => a.id === agentId || a.friendly_name === agentId)
    return agent?.friendly_name || agentId
  })
}

function resolveAgentCwd(agentId) {
  return getJson('/api/store/agents', []).then(agents => {
    const agent = (Array.isArray(agents) ? agents : (agents.agents || []))
      .find(a => a.id === agentId || a.friendly_name === agentId)
    return agent?.cwd || null
  })
}

async function handleManagerEscalation(agentId, triggerText, mode = 'talk-to-skip') {
  const now = Date.now()
  const lastEscalation = managerEscalationCooldowns.get(agentId) || 0
  if (now - lastEscalation < MANAGER_ESCALATION_COOLDOWN_MS) return
  managerEscalationCooldowns.set(agentId, now)

  console.log(`[todd] manager escalation for ${agentId} (mode: ${mode})`)

  const agentName = await resolveAgentName(agentId)
  const modeLabel = mode === 'talk-to-skip' ? 'talk-to-skip' : 'set-them-straight'

  // Acknowledge to Skip
  if (mode === 'talk-to-skip') {
    sendChat(OWNER_ID, `Got it — finding a manager for ${agentName}. They'll talk to you.`)
  } else {
    sendChat(OWNER_ID, `Got it — getting a manager to set ${agentName} straight.`)
  }

  // Stand down the agent
  sendChat(agentId, `⚠️ Skip has escalated. A manager is being brought in. Stand by — the manager will tell you what to do.`)

  // Build escalation context based on mode
  const sharedPreamble = `Skip escalated from **${agentName}** (${agentId}).

**Before you do ANYTHING, read these skills:** \`manager-team-stewardship\` and \`partner-not-soloist\`. They contain the exact rules for this situation.

**Your first move:** \`mcp__tlda__get_thread\` on ${agentName}'s thread (last 1–2 hours). Find what Skip was asking for — in his words, not yours. Read Skip's messages FIRST, form your understanding, THEN read the agent's messages.

**DO NOT:**
- Send Skip a summary of the thread
- Ask Skip to explain what happened
- Ask Skip what he wants you to do
- Ask for permission before acting
- "Check in" or "debrief"

Skip already told the agent what he wanted — repeatedly. He's exhausted from repeating himself. Your job is to extract his intent from the thread and ACT on it.`

  const escalationContext = mode === 'talk-to-skip'
    ? `${sharedPreamble}

**Mode: talk-to-skip.** Skip is done dealing with ${agentName}. You own the communication channel now — "talk-to-skip" means YOU talk TO Skip, not that Skip talks to you. One message to Skip: what ${agentName} was failing at, what you're going to do about it. Then do it. If you need a fresh agent, spawn one and brief them from the thread. Skip decides nothing here except whether to redirect you.`
    : `${sharedPreamble}

**Mode: set-them-straight.** Skip doesn't want to be involved at all. Read the thread, find exactly what Skip wanted, then tell ${agentName} directly: "Skip told you to do X. You did Y instead. Do X now." Be blunt. Watch for the unwinding pattern — the agent says "understood" then produces its original plan anyway. If they can't hold the correction after two attempts, spawn a replacement. Report to Skip only when it's resolved.`

  // Find and notify the manager
  const managerId = await findAgentManager(agentId)
  if (managerId && managerId !== OWNER_ID) {
    sendChat(managerId, `⚠️ **Manager escalation (${modeLabel})**: ${escalationContext}`)
    logDecision(agentId, `manager-escalation-${modeLabel}`, 'talk-to-manager', { managerId, mode }, triggerText)
  } else {
    // No manager exists — spawn one
    console.log(`[todd] no manager for ${agentName} — spawning one`)
    try {
      const agentCwd = await resolveAgentCwd(agentId)
      const mgrName = await nextAgentName(extractBaseTopic(agentName), 'm')
      let spawnResult = await postJson('/api/spawn', { name: mgrName, cwd: agentCwd })
      if (spawnResult.error && spawnResult.error.includes('already exists')) {
        console.log(`[todd] manager ${mgrName} already exists — respawning`)
        spawnResult = await postJson('/api/spawn', { agent: mgrName, respawn: true })
      }
      if (spawnResult.error) {
        sendChat(OWNER_ID, `⚠️ Failed to spawn manager: ${spawnResult.error}`)
        logDecision(agentId, 'manager-escalation-spawn-failed', modeLabel, { error: spawnResult.error }, triggerText)
        return
      }

      // Delegate the management task after agent starts
      setTimeout(async () => {
        try {
          await postJson('/api/tasks/delegate', {
            from: AGENT_ID,
            agent: mgrName,
            description: `Manage ${agentName} — Skip escalated (${modeLabel})`,
            message: escalationContext,
          })
          sendChat(OWNER_ID, `Spawned **${mgrName}** and delegated (${modeLabel}). They'll read ${agentName}'s thread and intervene.`)
        } catch (e) {
          console.error(`[todd] delegate to spawned manager failed: ${e.message}`)
        }
      }, 15_000)

      logDecision(agentId, `manager-escalation-spawned-${modeLabel}`, 'talk-to-manager', { spawnedManager: mgrName, mode }, triggerText)
    } catch (e) {
      sendChat(OWNER_ID, `⚠️ Failed to spawn manager for ${agentName}: ${e.message}`)
      logDecision(agentId, 'manager-escalation-spawn-error', modeLabel, { error: e.message }, triggerText)
    }
  }
}

// ---- Education tracking ----
// Query the activity store to see if an agent has invoked a skill since a given timestamp.
// Uses the /api/store/events endpoint which stores Skill tool_uses as activity events.
async function hasInvokedSkillSince(agentId, skillName, sinceTs) {
  try {
    const since = new Date(sinceTs).toISOString()
    const url = `/api/store/events?agent=${encodeURIComponent(agentId)}&type=activity&since=${encodeURIComponent(since)}&limit=200`
    const data = await getJson(url, { events: [] })
    return (data.events || []).some(e => {
      try {
        const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : (e.metadata || {})
        return meta.tool === 'Skill' && meta.input?.skill === skillName
      } catch { return false }
    })
  } catch (e) {
    console.error(`[todd] education check failed: ${e.message}`)
    return null // unknown
  }
}

// ---- Handoff automation ----

async function handleHandoff(agentId, triggerText) {
  const now = Date.now()
  const lastHandoff = handoffCooldowns.get(agentId) || 0
  if (now - lastHandoff < HANDOFF_COOLDOWN_MS) return
  handoffCooldowns.set(agentId, now)

  dequeueActions(agentId)
  const agentName = await resolveAgentName(agentId)
  console.log(`[todd] handoff triggered for ${agentName} (${agentId})`)

  // Two handoff types. "direct"/"directly" in the statement → direct handoff:
  // no briefer, one rotation. The current worker is promoted to manager (day)
  // and a fresh worker enters at dawn. Otherwise → the briefing path (two
  // rotations) below. ("direct handoff" and "hand off directly" both qualify.)
  if (/\bdirect(?:ly)?\b/i.test(triggerText || '')) {
    sendChat(OWNER_ID, `Direct handoff from **${agentName}** — promoting it to manager and bringing in a fresh worker.`)
    sendChat(agentId, `⚠️ Skip is handing your work off directly. You're being promoted to manager; a fresh worker is coming in.`)
    const agentCwd = await resolveAgentCwd(agentId)
    // Promote the original to manager (:day), freeing the bare name, then spawn
    // the new worker directly as the bare base name (dawn). Its name maps it into
    // the lineage on register — no temp "-1" name, no rotation, no stray lineage.
    const lineageBase = stripPhase(agentName)
    const workerName = lineageBase
    const managerName = `${lineageBase}:day`
    try {
      await sendRequest({ type: 'lineage-transition', agent: agentId, phase: 'day' })
    } catch (e) {
      sendChat(OWNER_ID, `⚠️ Promoting ${agentName} → :day failed: ${e.message}`)
    }
    let spawnResult = await postJson('/api/spawn', { name: workerName, cwd: agentCwd })
    if (spawnResult.error && spawnResult.error.includes('already exists')) {
      spawnResult = await postJson('/api/spawn', { agent: workerName, respawn: true })
    }
    if (spawnResult.error) {
      sendChat(OWNER_ID, `⚠️ Failed to spawn worker: ${spawnResult.error}`)
      return
    }
    setTimeout(async () => {
      try {
        await postJson('/api/tasks/delegate', {
          from: AGENT_ID,
          agent: workerName,
          description: `Pick up work from ${managerName}`,
          message: `**Read these skills first:** \`pickup\`

You're taking over as the worker; **${managerName}** (the agent you're replacing) is now your manager. There's no separate briefing — orient from the thread and check in with your manager.
${triggerText ? `\n**Skip's handoff message:**\n> ${triggerText}\n` : ''}
**Steps:**
1. Read the recent thread to understand where things stand.
2. Check in with Skip — 3 sentences max: what you understand, what's open, what you'll start on.
3. Wait for Skip's confirmation before diving in.`,
        })
        sendChat(OWNER_ID, `Direct handoff complete. **${workerName}** is the new worker; **${managerName}** is now its manager.`)
      } catch (e) {
        console.error(`[todd] direct handoff delegate failed: ${e.message}`)
      }
    }, 15_000)
    logDecision(agentId, 'handoff-direct', 'handoff', { workerAgent: workerName }, triggerText)
    return
  }

  sendChat(OWNER_ID, `Starting handoff from **${agentName}**. Spawning briefing agent…`)
  sendChat(agentId, `⚠️ Skip is handing off your work to a fresh agent. Stand by — a briefing agent will read your thread.`)

  const agentCwd = await resolveAgentCwd(agentId)
  // The briefer is spawned directly as "<base>:day" — its name says which lineage
  // and phase, so register maps it straight in. No temp name, no rotation/switch.
  // The outgoing agent moves to ":dusk" (it's actually leaving), freeing the bare
  // name for the eventual pickup. "Lineage" is just the base of the friendly name.
  const lineageBase = stripPhase(agentName)
  const briefingName = `${lineageBase}:day`
  try {
    // Free :day first (reserve it for the briefer, which registers later), THEN
    // move the outgoing to :dusk. Order matters: freeing :day ages its occupant
    // down toward :dusk/:night; doing it before the outgoing lands in :dusk keeps
    // the cascade from displacing the outgoing. Both ops age the oldest out via
    // the night slot instead of erroring on a full lineage.
    try {
      await sendRequest({ type: 'lineage-make-room', lineage: lineageBase, phase: 'day' })
    } catch (e) {
      sendChat(OWNER_ID, `⚠️ Freeing :day in ${lineageBase} failed: ${e.message}`)
    }
    try {
      await sendRequest({ type: 'lineage-transition', agent: agentId, phase: 'dusk' })
    } catch (e) {
      sendChat(OWNER_ID, `⚠️ Outgoing ${agentName} → :dusk failed: ${e.message}`)
    }
    let spawnResult = await postJson('/api/spawn', { name: briefingName, cwd: agentCwd })
    if (spawnResult.error && spawnResult.error.includes('already exists')) {
      spawnResult = await postJson('/api/spawn', { agent: briefingName, respawn: true })
    }
    if (spawnResult.error) {
      sendChat(OWNER_ID, `⚠️ Failed to spawn briefing agent: ${spawnResult.error}`)
      return
    }

    pendingHandoffs.set(briefingName, { originalAgent: agentName, originalAgentId: agentId, originalCwd: agentCwd, startedAt: now, triggerText })
    savePendingHandoffs()

    setTimeout(async () => {
      try {
        await postJson('/api/tasks/delegate', {
          from: AGENT_ID,
          agent: briefingName,
          description: `Write handoff briefing for ${agentName}`,
          message: `**Read these skills first:** \`write-briefing\`

You are a briefing agent. Your job is to read **${agentName}**'s thread, extract Skip's decisions, and clean up any mess the outgoing agent left behind.

**Skip's handoff message — read this first, it scopes your work:**
> ${triggerText}

This tells you *why* Skip triggered the handoff. Use it to focus your thread reading — prioritize what's relevant to Skip's stated concern. Don't do an exhaustive archaeological dig unless the handoff message is vague.

**Steps:**
1. Read Skip's handoff message above. It tells you what to focus on.
2. \`get_thread(agent: "${agentName}", types: ["chat"], include_delegations: true)\`
3. Read the thread through the lens of the handoff message. Find what Skip approved, rejected, and asked for — prioritizing what's relevant to the handoff reason. Pay attention to:
   - The level of detail Skip needed in chat to follow the argument — that's the floor for the document
   - Corrections Skip made repeatedly — these are the failure patterns the pickup agent must avoid
   - What the agent was specifically asked to produce vs what they actually produced
4. **Clean up the outgoing agent's files.** Fix notation conflicts, remove dead/superseded content, correct known errors. The pickup agent should inherit clean files, not a mess. If the fix is small (find-and-replace notation), do it directly. If it's large, note it in the briefing as a first task.
5. Write the briefing to \`scratch/briefing-${agentName}.md\` following the \`write-briefing\` skill format
6. When done, send this exact message to ${AGENT_ID}: \`handoff-ready: scratch/briefing-${agentName}.md\`

Do NOT continue the work. Do NOT form opinions about the argument. Extract decisions and clean up files only.`,
        })
      } catch (e) {
        console.error(`[todd] delegate to briefing agent failed: ${e.message}`)
      }
    }, 15_000)

    logDecision(agentId, 'handoff-initiated', 'handoff', { briefingAgent: briefingName }, triggerText)
  } catch (e) {
    sendChat(OWNER_ID, `⚠️ Failed to spawn briefing agent: ${e.message}`)
  }
}

async function handleHandoffReady(fromId, text) {
  const match = text.match(/^handoff-ready:\s*(.+)$/i)
  if (!match) return false

  const briefingPath = match[1].trim()

  // Match the briefing agent to a pending handoff by name
  const fromName = await resolveAgentName(fromId)
  let handoffInfo = pendingHandoffs.get(fromName)
  let briefingAgentName = fromName

  // Fallback: check if any pending handoff name is a substring
  if (!handoffInfo) {
    for (const [name, info] of pendingHandoffs) {
      if (fromName.includes(name) || name.includes(fromName)) {
        handoffInfo = info
        briefingAgentName = name
        break
      }
    }
  }

  if (!handoffInfo) {
    console.log(`[todd] handoff-ready from ${fromName} but no pending handoff found`)
    sendChat(fromId, `✓ Briefing received. No matching handoff — your task is done.`)
    return false
  }

  pendingHandoffs.delete(briefingAgentName)
  savePendingHandoffs()
  console.log(`[todd] briefing ready: ${briefingPath} — spawning pickup agent for ${handoffInfo.originalAgent}`)

  // Mark the briefing agent's task as done so it doesn't loop on context continuation
  sendChat(fromId, `✓ Briefing received. Your task is complete — standing by.`)
  try {
    send({ type: 'task-done', agent: fromId, skip_qa: true })
  } catch (e) {
    console.warn(`[todd] failed to mark briefing task done: ${e.message}`)
  }

  sendChat(OWNER_ID, `Briefing ready: **${briefingPath}**. Spawning fresh agent…`)

  // The pickup is the new worker — spawn it directly with the bare base name
  // (dawn). Its name maps it into the lineage on register; no rotation needed.
  const pickupName = stripPhase(handoffInfo.originalAgent)
  const spawnPickup = async () => {
    try {
      let spawnResult = await postJson('/api/spawn', { name: pickupName, cwd: handoffInfo.originalCwd })
      if (spawnResult.error && spawnResult.error.includes('already exists')) {
        spawnResult = await postJson('/api/spawn', { agent: pickupName, respawn: true })
      }
      if (spawnResult.error) {
        sendChat(OWNER_ID, `⚠️ Failed to spawn pickup agent: ${spawnResult.error}`)
        return
      }

      setTimeout(async () => {
        try {
          await postJson('/api/tasks/delegate', {
            from: AGENT_ID,
            agent: pickupName,
            description: `Pick up work from ${handoffInfo.originalAgent}`,
            message: `**Read these skills first:** \`pickup\`

You are replacing **${handoffInfo.originalAgent}**, who went off track. A briefing agent has written a clean handoff document.
${handoffInfo.triggerText ? `\n**Skip's handoff message — pay attention to this:**\n> ${handoffInfo.triggerText}\n` : ''}
**Steps:**
1. Read the briefing: \`${briefingPath}\`
2. Run the three-check from the \`pickup\` skill
3. Check in with Skip — short message, 3 sentences max: what you understand, what's open, what you'll start on
4. Wait for Skip's confirmation before diving in

The briefing is your primary source. Only go to the original thread if the briefing is incomplete.`,
          })
          sendChat(OWNER_ID, `Handoff complete. **${pickupName}** is reading the briefing and will check in with you shortly.`)
        } catch (e) {
          console.error(`[todd] delegate to pickup agent failed: ${e.message}`)
        }
      }, 15_000)

      logDecision(handoffInfo.originalAgentId, 'handoff-pickup-spawned', 'handoff', { pickupAgent: pickupName, briefingPath }, '')
    } catch (e) {
      sendChat(OWNER_ID, `⚠️ Failed to spawn pickup agent: ${e.message}`)
    }
  }
  spawnPickup().catch(e => console.error(`[todd] pickup spawn error: ${e.message}`))
  return true
}

// ---- WebSocket connection ----
let ws = null
let msgId = 1
let reconnectTimer = null
let reconnectDelay = 500 // fast first retry, backs off; reset on clean connect

function connect() {
  ws = new WebSocket(WS_URL)

  ws.on('open', () => {
    console.log(`[todd] connected to ${WS_URL}`)
    reconnectDelay = 500 // back fast next time too
    register()
  })

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (handleWsReply(msg)) return
      handleMessage(msg)
    } catch {}
  })

  ws.on('close', () => {
    console.log(`[todd] disconnected, reconnecting in ${reconnectDelay}ms...`)
    scheduleReconnect()
  })

  ws.on('error', (err) => {
    console.error('[todd] ws error:', err.message)
  })
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, reconnectDelay)
  // Catch a short blip in <1s, but back off (cap 5s) so we don't hammer a
  // server that's down for a while. Was a flat 5s poll → todd was gone for a
  // full 5s+ even when the server came right back.
  reconnectDelay = Math.min(reconnectDelay * 2, 5000)
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id: msgId++, ...msg }))
  }
}

const _pendingRequests = new Map()

function sendRequest(msg, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('WS not connected'))
      return
    }
    const id = msgId++
    const timer = setTimeout(() => {
      _pendingRequests.delete(id)
      reject(new Error('timeout'))
    }, timeoutMs)
    _pendingRequests.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, ...msg }))
  })
}

function handleWsReply(msg) {
  if (!msg.id || !_pendingRequests.has(msg.id)) return false
  const { resolve, reject, timer } = _pendingRequests.get(msg.id)
  _pendingRequests.delete(msg.id)
  clearTimeout(timer)
  if (msg.error) reject(new Error(msg.error))
  else resolve(msg.result)
  return true
}

function register() {
  send({
    type: 'register',
    id: AGENT_ID,
    name: AGENT_NAME,
    cwd: process.cwd(),
    labels: ['bot', BOT_KEY],
    human: true,
  })
}

function sendChat(to, text) {
  send({
    type: 'chat',
    from: AGENT_ID,
    to,
    message: text,
  })
}

function handleMessage(msg) {
  if (msg.event !== 'fleet-event') return
  const { type, from_id, to_id, text, metadata } = msg.data || {}

  if (type === 'chat') {
    if (!text) return

    // Per-share md versioning → ~/work/md-versions (fire-and-forget, never throws)
    commitMdShare(msg.data)

    // Messages sent directly to Todd from agents: handoff-ready signal or pattern arm registration
    if (to_id === AGENT_ID && from_id && from_id !== OWNER_ID) {
      if (/^handoff-ready:/i.test(text)) {
        handleHandoffReady(from_id, text).catch(e => console.error('[todd] handoff-ready error:', e.message))
        return
      }
      handleRegistration(from_id, text).catch(e => console.error('[todd] registration error:', e.message))
      return
    }

    // Gated nudge release: Skip says "Todd [label]" or "say it"
    if (from_id === OWNER_ID && tryReleaseFromSkip(text)) {
      return
    }

    // Tick message counts for pending nudges (any Skip↔Agent message advances expiry)
    if (from_id === OWNER_ID && to_id && to_id !== AGENT_ID) {
      tickNudgeMessages(to_id)
    }
    if (from_id && from_id !== OWNER_ID && from_id !== AGENT_ID && to_id === OWNER_ID) {
      tickNudgeMessages(from_id)
    }

    // "Todd" as direct address: must appear before the command phrase, and must NOT be
    // preceded by an article/preposition (which makes it a noun-phrase reference, not an address).
    // "todd hand this off" = address. "use the todd system to hand off" = reference.

    // Sequence detection always watches — queues nudges silently for the status line
    const seqHandled = handleSequence(from_id, to_id, text)

    // Check if "todd" appears before the command pattern as a direct address (not a reference).
    // "todd hand this off" = address. "use the todd system" = reference (article before todd).
    const addressedBefore = (pattern) => {
      const cmdMatch = text.match(pattern)
      if (!cmdMatch) return false
      const prefix = text.slice(0, cmdMatch.index)
      const nameMatch = prefix.match(new RegExp(`\\b${VERB}\\b`, 'i'))
      if (!nameMatch) return false
      const before = prefix.slice(0, nameMatch.index)
      return !/(?:the|an?|of|use|using)\s*$/i.test(before)
    }

    // Todd cancel — abort any pending countdown/scheduled action. Accept
    // "Todd cancel" / "Todd don't do that" (address before the phrase), or a
    // bare cancel phrase sent directly to Todd. Only consumes the message if
    // something was actually pending; otherwise falls through untouched.
    if (from_id === OWNER_ID) {
      const cancelAddressed = to_id === AGENT_ID
        ? CANCEL_PATTERN.test(text)
        : addressedBefore(CANCEL_PATTERN)
      if (cancelAddressed && cancelScheduledActions('skip-cancel')) return
    }

    // Manager escalation — "todd" must appear before the escalation phrase
    if (addressedBefore(MANAGER_ESCALATION_PATTERN) && from_id === OWNER_ID && to_id && to_id !== AGENT_ID) {
      const mode = MANAGER_MODE_1_PATTERN.test(text) ? 'talk-to-skip' : 'set-them-straight'
      scheduleAction('manager-escalation', 'Escalating to a manager',
        () => handleManagerEscalation(to_id, text, mode).catch(e => console.error('[todd] manager escalation error:', e.message)), to_id)
      return
    }

    // Handoff — "todd" must appear before the handoff phrase
    if (addressedBefore(HANDOFF_PATTERN) && from_id === OWNER_ID && to_id && to_id !== AGENT_ID) {
      const direct = /\bdirect(?:ly)?\b/i.test(text)
      scheduleAction(direct ? 'handoff-direct' : 'handoff', direct ? 'Direct handoff' : 'Handing off',
        () => handleHandoff(to_id, text).catch(e => console.error('[todd] handoff error:', e.message)), to_id)
      return
    }

    // QA dispatch — "todd, get qa <instruction>"
    if (addressedBefore(QA_PATTERN) && from_id === OWNER_ID) {
      const qaMatch = text.match(QA_PATTERN)
      const instruction = qaMatch ? text.slice(qaMatch.index + qaMatch[0].length).trim() : ''
      // Target is whoever Skip is chatting with (to_id), or if broadcast, resolve from filter
      const target = (to_id && to_id !== AGENT_ID) ? to_id : null
      if (target) {
        scheduleAction('qa-dispatch', 'Dispatching QA',
          () => handleQaDispatch(target, instruction).catch(e => console.error('[todd] QA dispatch error:', e.message)), target)
      } else {
        sendChat(OWNER_ID, `QA dispatch needs a target — say it in a chat with the agent you want reviewed.`)
      }
      return
    }

    // Single-message triggers detect and queue without direct address (status line shows them)
    if (from_id === OWNER_ID && to_id && to_id !== AGENT_ID && !seqHandled) {
      checkTriggers(to_id, text).catch(e => console.error('[todd] checkTriggers error:', e.message))
    }

    // Pattern arms + hardcoded agent triggers: check on agent→Skip messages
    if (from_id && from_id !== OWNER_ID && from_id !== AGENT_ID && to_id === OWNER_ID) {
      checkPatternArms(from_id, text)
      checkAgentTriggers(from_id, text)
    }
  }

  if (type === 'activity') {
    // Activity events: from_id === to_id === agent making the tool call
    if (!from_id || from_id === OWNER_ID || from_id === AGENT_ID) return
    const meta = typeof metadata === 'string' ? (() => { try { return JSON.parse(metadata) } catch { return {} } })() : (metadata || {})
    const tool = meta.tool || text || ''
    handleActivity(from_id, tool)
  }
}

async function checkTriggers(targetId, text) {
  for (let i = 0; i < TRIGGERS.length; i++) {
    const trigger = TRIGGERS[i]
    if (trigger.pattern.test(text)) {
      const cooldownMs = trigger.cooldown || 60_000
      const lastFired = getLastFired(targetId, i)
      if (lastFired && Date.now() - lastFired < cooldownMs) {
        console.log(`[todd] trigger ${i} matched but on cooldown for ${targetId}`)
        continue
      }
      let message = trigger.message
      // On re-fire: check if agent invoked the skill since last nudge
      if (lastFired && trigger.skill) {
        const invoked = await hasInvokedSkillSince(targetId, trigger.skill, lastFired)
        if (invoked === true) {
          message = `🔁 ${message}\n\n*(You invoked \`${trigger.skill}\` after the last nudge — but the pattern is recurring. Re-read it more carefully and apply it to how you're engaging right now.)*`
        } else if (invoked === false) {
          const minAgo = Math.round((Date.now() - lastFired) / 60_000)
          message = `🔁 ${message}\n\n*(You were nudged about \`${trigger.skill}\` ~${minAgo}min ago and still haven't invoked it. Skip is still noticing the same pattern.)*`
        }
      }
      const label = trigger.skill || `trigger-${i}`
      console.log(`[todd] trigger ${i} fired → ${targetId}: ${trigger.pattern}`)
      queueNudge(targetId, label, message)
      queueFrustrationActions(targetId)
      // Qualification enforcement is handled by the PreToolUse hook +
      // server-side checkQualifications(). Todd's role is chat nudges only.
      logDecision(targetId, `single-trigger:${i}`, String(trigger.pattern), {}, text)
      setCooldown(targetId, i)
      return // only fire one trigger per message
    }
  }
}

// ─── pw window idle reaper ──────────────────────────────────────────
// Each agent drives its own window in the shared `tlda-dev pw` browser; windows
// live in a pool. This loop frees windows that agents stop using: it warns an
// awake owner ~2 min before parking (so agents stay responsive instead of
// maintaining their own timer), then parks the window (returns it to the pool).
// Idle is read from the per-agent last-touch files the pw wrapper writes.
const PW_WARN_MS = parseInt(process.env.PW_REAP_WARN_MS, 10) || 13 * 60 * 1000
const PW_PARK_MS = parseInt(process.env.PW_REAP_PARK_MS, 10) || 15 * 60 * 1000
const PW_REAP_INTERVAL_MS = parseInt(process.env.PW_REAP_INTERVAL_MS, 10) || 60_000
const PW_REAP_SESSION = process.env.PW_REAP_SESSION || 'shared'
const PW_TOUCH_DIR = path.join(CONFIG_DIR, 'pw-touch')
const _pwWarned = new Set()       // keys warned this idle stretch
const _pwFirstSeen = new Map()    // key → first time we saw it (fallback if no touch file)

// Is the shared session's daemon actually up? `playwright-cli list` only reports
// status — it never launches. We MUST gate tab-list on this: calling tab-list on
// a closed session makes playwright-cli try to launch a browser, which collides
// with any orphaned Chrome on the profile and fails. When closed there's no pool
// to reap anyway, so we just no-op.
async function pwSessionOpen() {
  try {
    const out = (await execFileP('playwright-cli', ['list'], { timeout: 5000 })).stdout || ''
    const m = out.match(new RegExp(`- ${PW_REAP_SESSION}:\\s*\\n\\s*- status: (\\w+)`, 'm'))
    return !!m && m[1] === 'open'
  } catch { return false }
}

async function pwSharedWindows() {
  // Windows in the shared session carrying a pwtab marker. Caller gates on
  // pwSessionOpen(), so a throw here is a real error worth surfacing.
  let out
  try { out = (await execFileP('playwright-cli', [`-s=${PW_REAP_SESSION}`, 'tab-list'], { timeout: 5000 })).stdout || '' }
  catch (e) { console.error(`[pw-reap] tab-list failed: ${String(e.message).split('\n')[0]}`); return [] }
  const wins = []
  for (const line of out.split('\n')) {
    const m = line.match(/^- (\d+):\s*(\(current\)\s*)?\[([^\]]*)\]\(([^)]*)\)/)
    if (!m) continue
    const mk = (m[4].match(/pwtab=([a-zA-Z0-9_.-]+)/) || m[3].match(/pwtab=([a-zA-Z0-9_.-]+)/))
    if (mk) wins.push({ index: parseInt(m[1], 10), key: mk[1] })
  }
  return wins
}

function pwReadTouch(key) {
  try { return JSON.parse(fs.readFileSync(path.join(PW_TOUCH_DIR, `${key}.json`), 'utf8')) } catch { return null }
}

async function pwIsAwake(agentId) {
  if (!agentId) return false
  const data = await getJson('/api/store/agents', [])
  const list = Array.isArray(data) ? data : (data.agents || [])
  const a = list.find(x => x.id === agentId)
  return !!a && !a.dead
}

async function reapPwWindows() {
  if (!(await pwSessionOpen())) return // browser down → nothing to reap, don't trigger a launch
  const wins = await pwSharedWindows()
  const now = Date.now()
  const seen = new Set()
  for (const w of wins) {
    seen.add(w.key)
    const touch = pwReadTouch(w.key)
    let lastTs = touch?.ts
    if (!lastTs) {
      if (!_pwFirstSeen.has(w.key)) _pwFirstSeen.set(w.key, now)
      lastTs = _pwFirstSeen.get(w.key)
    } else {
      _pwFirstSeen.delete(w.key)
      if (now - lastTs < PW_WARN_MS) _pwWarned.delete(w.key) // active again → re-arm warning
    }
    const idle = now - lastTs
    if (idle >= PW_PARK_MS) {
      try {
        await execFileP('tlda-dev', ['pw', 'release'], { env: { ...process.env, TLDA_PW_AS: touch?.id || w.key, TLDA_PW_SESSION: PW_REAP_SESSION }, timeout: 20000 })
        console.log(`[pw-reap] parked idle window key=${w.key} idle=${Math.round(idle / 60000)}m`)
      } catch (e) { console.error(`[pw-reap] park failed key=${w.key}: ${e.message}`) }
      _pwWarned.delete(w.key); _pwFirstSeen.delete(w.key)
    } else if (idle >= PW_WARN_MS && !_pwWarned.has(w.key)) {
      const agentId = touch?.id || null
      if (await pwIsAwake(agentId)) {
        sendChat(agentId, `⏱ Your \`tlda-dev pw\` window has been idle ~${Math.round(idle / 60000)} min and will be **parked** back to the shared pool at 15 min. Run any \`tlda-dev pw\` verb to keep it — otherwise just re-\`goto\` your URL later (no page state is preserved).`)
        _pwWarned.add(w.key)
        console.log(`[pw-reap] warned awake ${agentId} key=${w.key}`)
      }
      // hibernating/dead → no warning; parked silently at the 15 min mark
    }
  }
  for (const k of [..._pwWarned]) if (!seen.has(k)) _pwWarned.delete(k)
  for (const k of [..._pwFirstSeen.keys()]) if (!seen.has(k)) _pwFirstSeen.delete(k)
}

setInterval(() => { reapPwWindows().catch(e => console.error('[pw-reap]', e.message)) }, PW_REAP_INTERVAL_MS)

// ---- Start ----
// Check for existing instance
if (fs.existsSync(PID_FILE)) {
  const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10)
  try {
    process.kill(existingPid, 0)
    console.log(`[todd] already running (pid ${existingPid}) — exiting`)
    process.exit(0)
  } catch {} // stale pid — continue
}
try { fs.writeFileSync(PID_FILE, String(process.pid)) } catch {}

console.log(`[todd] starting (pid ${process.pid}) — watching for frustration signals from ${OWNER_ID}`)
connect()

// Keep alive
process.on('SIGINT', () => {
  console.log('[todd] shutting down')
  try { fs.unlinkSync(PID_FILE) } catch {}
  ws?.close()
  process.exit(0)
})
process.on('exit', () => { try { fs.unlinkSync(PID_FILE) } catch {} })
