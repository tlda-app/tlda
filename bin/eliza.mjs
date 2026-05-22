#!/usr/bin/env node
/**
 * eliza — pseudo-agent that watches Skip's chat messages for frustration
 * signals and sends the target agent a corrective nudge. Pure regex
 * pattern matching, no LLM. Registers as a fleet agent, communicates
 * via chat, but is just a decision tree.
 *
 * Usage:  node bin/eliza.mjs
 *    or:  tlda eliza start / stop / status
 */

import WebSocket from 'ws'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import https from 'https'
import http from 'http'

import { getServerUrl, CONFIG_DIR } from '../shared/config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PID_FILE = path.join(CONFIG_DIR, 'eliza.pid')
const SERVER = getServerUrl()
const WS_URL = SERVER.replace(/^http/, 'ws') + '/ws/fleet'
const OWNER_ID = 'fleet:skip'
const AGENT_ID = 'fleet:eliza'
const AGENT_NAME = 'eliza'

// ---- Decision log ----
// JSONL file recording every Eliza action + state snapshot for later HMM training.
// Each line: { ts, agent, action, trigger, state, text_snippet, reward? }
const DECISIONS_LOG = path.join(CONFIG_DIR, 'eliza-decisions.jsonl')

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
    console.error(`[eliza] log write failed: ${e.message}`)
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
    console.error(`[eliza] log write failed: ${e.message}`)
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
    pattern: /cop.?out/i,
    message: `⚠️ Skip identified a hand-wave in your reasoning. "By definition" or "it follows" is not a proof step — it's a claim you haven't justified. State the precise claim, then prove it step by step. No shortcuts.`,
  },
  {
    pattern: /\bi'?m struggling\b/i,
    skill: 'partner-not-soloist',
    message: `⚠️ Skip is telling you he's having trouble following. This is not a cue to explain faster or more confidently — it's a cue to slow down, be more explicit, and check whether your formulation is precise enough to be right or wrong. Read \`partner-not-soloist\`.`,
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
    pattern: /\brude\b/i,
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
  /cop.?out/i,
  /\bi'?m struggling\b/i,
  /you don'?t understand/i,
  /\bthat'?s useless\b/i,
  /\brude\b/i,
  /\bhurtful\b|\bfeel stupid\b/i,
  /^(?:bro|wtf)\s*$/i,
  /\bfuck you\b/i,
  /\bno[,.]?\s+that/i,
  /\bthat'?s not (right|what|correct)/i,
  /\bwrong\b/i,
  // From log research — real patterns Skip uses when correcting
  /what the fuck/i,
  /you'?re wrong/i,
  /what are you talking about/i,
  /\bi don'?t understand what you'?re saying\b/i,
  /\bstop not knowing\b/i,
  /\byou'?re being (fucking |)thick\b/i,
  /\bdismissive\b/i,
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
        console.log(`[eliza] fuck-you-in-context → ${toId} (phase=${state.phase})`)
        sendChat(toId, FUCK_YOU_IN_CONTEXT_MSG)
        logDecision(toId, 'fuck-you-in-context', 'fuck-you-while-corrected', { phase: state.phase }, text)
        startRewardWindow(toId, 'fuck-you-in-context')
        state.phase = 'idle'
        state.windowStart = 0
        pendingSkipMessages.delete(toId)
        return 'handled'
      }

      if (state.phase === 'acked') {
        console.log(`[eliza] performing-understanding → ${toId}`)
        sendChat(toId, PERFORMING_UNDERSTANDING_MSG)
        logDecision(toId, 'performing-understanding', 'correction-after-ack', { phase: state.phase }, text)
        startRewardWindow(toId, 'performing-understanding')
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
        console.log(`[eliza] narrowing detected → ${toId}`)
        sendChat(toId, NARROWING_MSG)
        logDecision(toId, 'narrowing', 'skip-narrowed-task', {}, text)
        startRewardWindow(toId, 'narrowing')
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
        console.log(`[eliza] ack-opener detected from ${fromId}, phase → acked`)
      }

      // Thirsty-ack: only fire when already in a correction sequence
      // Data shows 73% false positive rate without this gate — agents say "Right —"
      // and then give substantive responses, which isn't hollow understanding.
      const wordCount = text.trim().split(/\s+/).length
      if (wordCount > THIRSTY_ACK_WORD_THRESHOLD && state.phase === 'corrected') {
        const lastThirsty = thirstyAckCooldowns.get(fromId) || 0
        if (now - lastThirsty > THIRSTY_ACK_COOLDOWN_MS) {
          console.log(`[eliza] thirsty-ack → ${fromId} (${wordCount} words, in correction sequence)`)
          sendChat(fromId, THIRSTY_ACK_MSG)
          logDecision(fromId, 'thirsty-ack', `ack-opener+${wordCount}-words+corrected`, { wordCount, phase: state.phase }, text)
          startRewardWindow(fromId, 'thirsty-ack')
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
        console.log(`[eliza] punt detected from ${fromId}`)
        sendChat(fromId, PUNT_MSG)
        logDecision(fromId, 'punt', 'punt-phrase-detected', {}, text)
        startRewardWindow(fromId, 'punt')
        puntCooldowns.set(fromId, now)
        return 'handled'
      }
    }

    // Contradiction detector
    if (isContradiction(text)) {
      const lastContradiction = contradictionCooldowns.get(fromId) || 0
      if (now - lastContradiction > CONTRADICTION_COOLDOWN_MS) {
        console.log(`[eliza] contradiction detected from ${fromId}`)
        sendChat(fromId, CONTRADICTION_MSG)
        logDecision(fromId, 'contradiction', 'contradiction-phrase-detected', {}, text)
        startRewardWindow(fromId, 'contradiction')
        contradictionCooldowns.set(fromId, now)
      }
    }

    // Remark detector — nudge agents who mention "remark" with a checklist
    if (isRemarkMention(text)) {
      const lastRemark = remarkCooldowns.get(fromId) || 0
      if (now - lastRemark > REMARK_COOLDOWN_MS) {
        console.log(`[eliza] remark mention detected from ${fromId}`)
        sendChat(fromId, REMARK_MSG)
        logDecision(fromId, 'remark', 'remark-mention-detected', {}, text)
        startRewardWindow(fromId, 'remark')
        remarkCooldowns.set(fromId, now)
      }
    }

    // Wrap-up detector — agent tries to end the conversation
    if (isWrapup(text)) {
      const lastWrapup = wrapupCooldowns.get(fromId) || 0
      if (now - lastWrapup > WRAPUP_COOLDOWN_MS) {
        console.log(`[eliza] wrap-up detected from ${fromId}`)
        sendChat(fromId, WRAPUP_MSG)
        logDecision(fromId, 'wrapup', 'agent-tried-to-end-conversation', {}, text)
        startRewardWindow(fromId, 'wrapup')
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

  console.log(`[eliza] running-away → ${agentId} (${tool} after ${Math.round(elapsed/1000)}s, no reply to Skip)`)
  sendChat(agentId, RUNNING_AWAY_MSG)
  logDecision(agentId, 'running-away', `write-tool-while-unacknowledged:${tool}`, { elapsedSec: Math.round(elapsed/1000) }, null)
  startRewardWindow(agentId, 'running-away')
  pending.nudgeSent = true
}

// ---- Agent-registered pattern arms ----
// Agents can chat Eliza to register per-session watches on outgoing messages.
// By default, watches the registering agent's own messages to Skip.
// Use `for: agent-name` to watch a different agent's messages instead.
// Format (sent to fleet:eliza):
//   watch: term1|term2|term3          ← pipe- or comma-separated terms, or /regex/flags
//   for: agent-name                   ← optional: watch this agent's messages instead of your own
//   nudge: Optional custom message    ← if omitted, uses default template
//
// When a registered term appears in the agent's message to Skip, Eliza nudges the agent.
// Registration is session-scoped (in-memory only).
//
// Example from agent-jcbn:
//   watch: kernel embedding|L_\infty|norm ball|seminorm ball|infinity norm
//   nudge: Check — is this an L∞ shortcut? Flag it explicitly before relaying to Skip.
const agentPatternArms = new Map()
// agentId → [{ pattern: RegExp, message: string, cooldownMs: number, lastFired: number }]

const DEFAULT_ARM_NUDGE = (terms) =>
  `💭 Your message contains a term you flagged for self-review (${terms}). Check: is this the shortcut/pattern you were watching for? If so, stop and address it explicitly before Skip sees it.`

function resolveAgentId(nameOrId) {
  try {
    const url = `${SERVER}/api/store/agents`
    const mod = url.startsWith('https') ? https : http
    return new Promise((resolve) => {
      mod.get(url, res => {
        let buf = ''
        res.on('data', c => buf += c)
        res.on('end', () => {
          try {
            const agents = JSON.parse(buf)
            const list = Array.isArray(agents) ? agents : (agents.agents || [])
            const agent = list.find(a => a.id === nameOrId || a.friendly_name === nameOrId)
            resolve(agent?.id || null)
          } catch { resolve(null) }
        })
      }).on('error', () => resolve(null))
    })
  } catch { return Promise.resolve(null) }
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
      sendChat(fromId, `⚠️ Eliza couldn't parse that regex: ${e.message}`)
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
  console.log(`[eliza] pattern arm registered for ${targetId} by ${fromId}: ${pattern} (${count} total)`)
  sendChat(fromId, `✓ Watching ${targetLabel ? targetLabel + "'s" : 'your'} messages for: \`${termsRaw}\`${forMsg}`)
  return true
}

function checkPatternArms(agentId, text) {
  const arms = agentPatternArms.get(agentId)
  if (!arms?.length) return
  const now = Date.now()
  for (const arm of arms) {
    if (arm.pattern.test(text) && now - arm.lastFired > arm.cooldownMs) {
      const target = arm.nudgeTarget || agentId
      console.log(`[eliza] pattern arm fired → ${target} (watching ${agentId}): ${arm.pattern}`)
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
// Imperative handoff commands only — must start the message or follow a period/comma.
// "hand this off" at the start = command. "should we hand this off?" = discussion, not a trigger.
const HANDOFF_PATTERN = /(?:^|[.!]\s*)(?:(?:I\s+(?:want|wanna|need)\s+to\s+)?hand\s+(?:this\s+)?off|do\s+(?:a\s+)?handoff|let'?s\s+(?:(?:do\s+(?:a\s+)?)?handoff|hand\s+(?:this\s+)?off)|time\s+(?:for\s+(?:a\s+)?)?handoff)\b/i
const handoffCooldowns = new Map()
const HANDOFF_COOLDOWN_MS = 120_000
const pendingHandoffs = new Map()
const MANAGER_ESCALATION_COOLDOWN_MS = 60_000

function postJson(urlPath, body) {
  const url = `${SERVER}${urlPath}`
  const mod = url.startsWith('https') ? https : http
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let buf = ''
      res.on('data', c => buf += c)
      res.on('end', () => { try { resolve(JSON.parse(buf)) } catch (e) { resolve({ raw: buf }) } })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

async function findAgentManager(agentId) {
  try {
    const url = `${SERVER}/api/store/tasks`
    const mod = url.startsWith('https') ? https : http
    const data = await new Promise((resolve, reject) => {
      mod.get(url, res => {
        let buf = ''
        res.on('data', c => buf += c)
        res.on('end', () => { try { resolve(JSON.parse(buf)) } catch (e) { reject(e) } })
      }).on('error', reject)
    })
    const tasks = Array.isArray(data) ? data : (data.tasks || [])
    const activeTask = tasks.find(t => t.agent === agentId && t.status === 'pending' && t.delegated_by)
    return activeTask?.delegated_by || null
  } catch (e) {
    console.error(`[eliza] findAgentManager failed: ${e.message}`)
    return null
  }
}

function resolveAgentName(agentId) {
  try {
    const url = `${SERVER}/api/store/agents`
    const mod = url.startsWith('https') ? https : http
    return new Promise((resolve) => {
      mod.get(url, res => {
        let buf = ''
        res.on('data', c => buf += c)
        res.on('end', () => {
          try {
            const agents = JSON.parse(buf)
            const agent = (Array.isArray(agents) ? agents : (agents.agents || []))
              .find(a => a.id === agentId || a.friendly_name === agentId)
            resolve(agent?.friendly_name || agentId)
          } catch { resolve(agentId) }
        })
      }).on('error', () => resolve(agentId))
    })
  } catch { return agentId }
}

function resolveAgentCwd(agentId) {
  try {
    const url = `${SERVER}/api/store/agents`
    const mod = url.startsWith('https') ? https : http
    return new Promise((resolve) => {
      mod.get(url, res => {
        let buf = ''
        res.on('data', c => buf += c)
        res.on('end', () => {
          try {
            const agents = JSON.parse(buf)
            const agent = (Array.isArray(agents) ? agents : (agents.agents || []))
              .find(a => a.id === agentId || a.friendly_name === agentId)
            resolve(agent?.cwd || null)
          } catch { resolve(null) }
        })
      }).on('error', () => resolve(null))
    })
  } catch { return null }
}

async function handleManagerEscalation(agentId, triggerText, mode = 'talk-to-skip') {
  const now = Date.now()
  const lastEscalation = managerEscalationCooldowns.get(agentId) || 0
  if (now - lastEscalation < MANAGER_ESCALATION_COOLDOWN_MS) return
  managerEscalationCooldowns.set(agentId, now)

  console.log(`[eliza] manager escalation for ${agentId} (mode: ${mode})`)

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

**Your first move:** \`mcp__fleet__get_thread\` on ${agentName}'s thread (last 1–2 hours). Find what Skip was asking for — in his words, not yours. Read Skip's messages FIRST, form your understanding, THEN read the agent's messages.

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
    console.log(`[eliza] no manager for ${agentName} — spawning one`)
    try {
      const agentCwd = await resolveAgentCwd(agentId)
      const mgrName = `mgr-${agentName}`
      let spawnResult = await postJson('/api/spawn', { name: mgrName, cwd: agentCwd })
      if (spawnResult.error && spawnResult.error.includes('already exists')) {
        console.log(`[eliza] manager ${mgrName} already exists — respawning`)
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
          console.error(`[eliza] delegate to spawned manager failed: ${e.message}`)
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
    const url = `${SERVER}/api/store/events?agent=${encodeURIComponent(agentId)}&type=activity&since=${encodeURIComponent(since)}&limit=200`
    const mod = url.startsWith('https') ? https : http
    const data = await new Promise((resolve, reject) => {
      mod.get(url, res => {
        let buf = ''
        res.on('data', c => buf += c)
        res.on('end', () => { try { resolve(JSON.parse(buf)) } catch (e) { reject(e) } })
      }).on('error', reject)
    })
    return (data.events || []).some(e => {
      try {
        const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : (e.metadata || {})
        return meta.tool === 'Skill' && meta.input?.skill === skillName
      } catch { return false }
    })
  } catch (e) {
    console.error(`[eliza] education check failed: ${e.message}`)
    return null // unknown
  }
}

// ---- Handoff automation ----

async function handleHandoff(agentId, triggerText) {
  const now = Date.now()
  const lastHandoff = handoffCooldowns.get(agentId) || 0
  if (now - lastHandoff < HANDOFF_COOLDOWN_MS) return
  handoffCooldowns.set(agentId, now)

  const agentName = await resolveAgentName(agentId)
  console.log(`[eliza] handoff triggered for ${agentName} (${agentId})`)

  sendChat(OWNER_ID, `Starting handoff from **${agentName}**. Spawning briefing agent…`)
  sendChat(agentId, `⚠️ Skip is handing off your work to a fresh agent. Stand by — a briefing agent will read your thread.`)

  const agentCwd = await resolveAgentCwd(agentId)
  const briefingName = `briefing-${agentName}`
  try {
    let spawnResult = await postJson('/api/spawn', { name: briefingName, cwd: agentCwd })
    if (spawnResult.error && spawnResult.error.includes('already exists')) {
      spawnResult = await postJson('/api/spawn', { agent: briefingName, respawn: true })
    }
    if (spawnResult.error) {
      sendChat(OWNER_ID, `⚠️ Failed to spawn briefing agent: ${spawnResult.error}`)
      return
    }

    pendingHandoffs.set(briefingName, { originalAgent: agentName, originalAgentId: agentId, originalCwd: agentCwd, startedAt: now })

    setTimeout(async () => {
      try {
        await postJson('/api/tasks/delegate', {
          from: AGENT_ID,
          agent: briefingName,
          description: `Write handoff briefing for ${agentName}`,
          message: `**Read these skills first:** \`write-briefing\`

You are a briefing agent. Your job is to read **${agentName}**'s thread, extract Skip's decisions, and clean up any mess the outgoing agent left behind.

**Steps:**
1. \`get_thread(agent: "${agentName}", types: ["chat"], include_delegations: true)\`
2. Read the FULL thread — take your time (5-10 minutes). Find what Skip approved, rejected, and asked for. Pay attention to:
   - The level of detail Skip needed in chat to follow the argument — that's the floor for the document
   - Corrections Skip made repeatedly — these are the failure patterns the pickup agent must avoid
   - What the agent was specifically asked to produce vs what they actually produced
3. **Clean up the outgoing agent's files.** Fix notation conflicts, remove dead/superseded content, correct known errors. The pickup agent should inherit clean files, not a mess. If the fix is small (find-and-replace notation), do it directly. If it's large, note it in the briefing as a first task.
4. Write the briefing to \`scratch/briefing-${agentName}.md\` following the \`write-briefing\` skill format
5. When done, send this exact message to fleet:eliza: \`handoff-ready: scratch/briefing-${agentName}.md\`

Do NOT continue the work. Do NOT form opinions about the argument. Extract decisions and clean up files only.`,
        })
      } catch (e) {
        console.error(`[eliza] delegate to briefing agent failed: ${e.message}`)
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
    // Reconstruct from naming convention: briefing agent is "briefing-<original>"
    const briefingMatch = fromName.match(/^briefing-(.+)$/i)
    if (briefingMatch) {
      const origName = briefingMatch[1]
      const origCwd = await resolveAgentCwd(origName) || process.cwd()
      handoffInfo = { originalAgent: origName, originalAgentId: origName, originalCwd: origCwd, startedAt: Date.now() }
      briefingAgentName = fromName
      console.log(`[eliza] handoff-ready: reconstructed handoff info for ${origName} from naming convention`)
    } else {
      console.log(`[eliza] handoff-ready from ${fromName} but no pending handoff found`)
      sendChat(fromId, `✓ Briefing received. No matching handoff — your task is done.`)
      return false
    }
  }

  pendingHandoffs.delete(briefingAgentName)
  console.log(`[eliza] briefing ready: ${briefingPath} — spawning pickup agent for ${handoffInfo.originalAgent}`)

  // Mark the briefing agent's task as done so it doesn't loop on context continuation
  sendChat(fromId, `✓ Briefing received. Your task is complete — standing by.`)
  try {
    send({ type: 'task-done', agent: fromId, skip_qa: true })
  } catch (e) {
    console.warn(`[eliza] failed to mark briefing task done: ${e.message}`)
  }

  sendChat(OWNER_ID, `Briefing ready: **${briefingPath}**. Spawning fresh agent…`)

  const pickupName = `pickup-${handoffInfo.originalAgent}`
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

**Steps:**
1. Read the briefing: \`${briefingPath}\`
2. Run the three-check from the \`pickup\` skill
3. Check in with Skip — short message, 3 sentences max: what you understand, what's open, what you'll start on
4. Wait for Skip's confirmation before diving in

The briefing is your primary source. Only go to the original thread if the briefing is incomplete.`,
          })
          sendChat(OWNER_ID, `Handoff complete. **${pickupName}** is reading the briefing and will check in with you shortly.`)
        } catch (e) {
          console.error(`[eliza] delegate to pickup agent failed: ${e.message}`)
        }
      }, 15_000)

      logDecision(handoffInfo.originalAgentId, 'handoff-pickup-spawned', 'handoff', { pickupAgent: pickupName, briefingPath }, '')
    } catch (e) {
      sendChat(OWNER_ID, `⚠️ Failed to spawn pickup agent: ${e.message}`)
    }
  }
  spawnPickup().catch(e => console.error(`[eliza] pickup spawn error: ${e.message}`))
  return true
}

// ---- WebSocket connection ----
let ws = null
let msgId = 1
let reconnectTimer = null

function connect() {
  ws = new WebSocket(WS_URL)

  ws.on('open', () => {
    console.log(`[eliza] connected to ${WS_URL}`)
    register()
  })

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      handleMessage(msg)
    } catch {}
  })

  ws.on('close', () => {
    console.log('[eliza] disconnected, reconnecting in 5s...')
    scheduleReconnect()
  })

  ws.on('error', (err) => {
    console.error('[eliza] ws error:', err.message)
  })
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, 5000)
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id: msgId++, ...msg }))
  }
}

function register() {
  send({
    type: 'register',
    id: AGENT_ID,
    name: AGENT_NAME,
    cwd: process.cwd(),
    labels: ['bot', 'eliza'],
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

    // Messages sent directly to Eliza from agents: handoff-ready signal or pattern arm registration
    if (to_id === AGENT_ID && from_id && from_id !== OWNER_ID) {
      if (/^handoff-ready:/i.test(text)) {
        handleHandoffReady(from_id, text).catch(e => console.error('[eliza] handoff-ready error:', e.message))
        return
      }
      handleRegistration(from_id, text).catch(e => console.error('[eliza] registration error:', e.message))
      return
    }

    // Sequence detection watches both directions
    const seqHandled = handleSequence(from_id, to_id, text)

    // Manager escalation — fires before other triggers, returns early
    if (from_id === OWNER_ID && to_id && to_id !== AGENT_ID && MANAGER_ESCALATION_PATTERN.test(text)) {
      const mode = MANAGER_MODE_1_PATTERN.test(text) ? 'talk-to-skip' : 'set-them-straight'
      handleManagerEscalation(to_id, text, mode).catch(e => console.error('[eliza] manager escalation error:', e.message))
      return
    }

    // Handoff — Skip says "hand this off" to an agent
    if (from_id === OWNER_ID && to_id && to_id !== AGENT_ID && HANDOFF_PATTERN.test(text)) {
      handleHandoff(to_id, text).catch(e => console.error('[eliza] handoff error:', e.message))
      return
    }

    // Single-message triggers only fire on Skip's outgoing messages (and if sequence didn't already handle it)
    if (from_id === OWNER_ID && to_id && to_id !== AGENT_ID && !seqHandled) {
      checkTriggers(to_id, text).catch(e => console.error('[eliza] checkTriggers error:', e.message))
    }

    // Pattern arms: check agent's registered patterns on their outgoing messages to Skip
    if (from_id && from_id !== OWNER_ID && from_id !== AGENT_ID && to_id === OWNER_ID) {
      checkPatternArms(from_id, text)
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
        console.log(`[eliza] trigger ${i} matched but on cooldown for ${targetId}`)
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
      console.log(`[eliza] trigger ${i} fired → ${targetId}: ${trigger.pattern}`)
      sendChat(targetId, message)
      logDecision(targetId, `single-trigger:${i}`, String(trigger.pattern), {}, text)
      startRewardWindow(targetId, `single-trigger:${i}`)
      setCooldown(targetId, i)
      return // only fire one trigger per message
    }
  }
}

// ---- Start ----
// Check for existing instance
if (fs.existsSync(PID_FILE)) {
  const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10)
  try {
    process.kill(existingPid, 0)
    console.log(`[eliza] already running (pid ${existingPid}) — exiting`)
    process.exit(0)
  } catch {} // stale pid — continue
}
try { fs.writeFileSync(PID_FILE, String(process.pid)) } catch {}

console.log(`[eliza] starting (pid ${process.pid}) — watching for frustration signals from ${OWNER_ID}`)
connect()

// Keep alive
process.on('SIGINT', () => {
  console.log('[eliza] shutting down')
  try { fs.unlinkSync(PID_FILE) } catch {}
  ws?.close()
  process.exit(0)
})
process.on('exit', () => { try { fs.unlinkSync(PID_FILE) } catch {} })
