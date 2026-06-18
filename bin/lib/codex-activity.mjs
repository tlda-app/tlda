// Codex rollout activity source — map OpenAI Codex CLI session transcripts to
// the same internal event shape the Claude-JSONL path produces, so a Codex
// fleet agent yields the same activity cards (and search backfill) as a Claude
// agent with zero changes downstream.
//
// Claude agents write ~/.claude/projects/<hash>/<session>.jsonl; the daemon
// tails them and runs parseSessionLine() → extractActivityEvents(). Codex agents
// write ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl. Same idea — a
// JSONL we tail — but a different record schema. parseCodexLine() is the Codex
// analog of parseSessionLine(): one rollout line in, one normalized event out
// (or null to skip), in the exact { type, timestamp, blocks, usage } shape that
// extractActivityEvents() already consumes.
//
// Codex rollout record types (verified against real rollouts, Codex v0.140.0):
//   { type:'session_meta', payload:{ id, cwd, ... } }          — session header (skip)
//   { type:'turn_context', ... }                               — (skip)
//   { type:'event_msg', payload:{ type:'user_message'|'agent_message'|
//        'token_count'|'task_started'|'task_complete', ... } }
//   { type:'response_item', payload:{ type:'message'|'function_call'|
//        'function_call_output', ... } }
//
// Tool-call shape: Codex emits fleet MCP tools as
//   { type:'function_call', name:'register', namespace:'mcp__tlda', arguments:'{...}', call_id }
// (note: bare `name` + separate `namespace` — NOT Claude's flat 'mcp__tlda__register').
// Native tools come WITHOUT a namespace, e.g. exec_command (shell): { name:'exec_command',
// arguments:'{"cmd":"ls","workdir":...}' }. normalizeToolName/aliasNativeArgs bridge both
// to what extractActivityEvents expects (a flat 'mcp__tlda__x' name; an `input.command`
// for shell), so the noise filter and arg extraction work unchanged.

import { normalizePrettyResult } from '../../shared/activity-pretty-result.mjs'

// Native Codex tool name → Claude vocabulary, so a Codex agent's activity
// stream reads identically to a Claude agent's (Skip's call, 2026-06-15:
// "use the Claude vocabulary, it's so much easier to understand").
// VERIFIED against real rollouts: exec_command, update_plan. The rest are
// Codex's documented native tools, mapped best-effort; any name NOT in this
// map falls through to its literal Codex name (so an unmapped/renamed tool
// shows honestly rather than as a wrong guess).
const NATIVE_NAME_MAP = {
  // verified (observed in rollouts):
  exec_command: 'Bash',        // Codex's shell — also how it edits files (cat/sed), so Bash covers edits too
  update_plan: 'TodoWrite',    // Codex's step-plan tool ≈ Claude's todo/plan tool
  // documented Codex native tools (map when first observed to confirm exact name):
  shell: 'Bash',
  local_shell: 'Bash',
  apply_patch: 'Edit',
  read_file: 'Read',
  web_search: 'WebSearch',
  view_image: 'Read',
}

// Map (name, namespace) → the flat tool name extractActivityEvents keys on.
// Fleet MCP tools carry namespace 'mcp__tlda'; flattening to 'mcp__tlda__<name>'
// makes them match the daemon's ACTIVITY_NOISE set and produce humanName
// 'tlda/<name>'. Native tools (no namespace) are relabelled to Claude vocab
// via NATIVE_NAME_MAP, falling through to the literal name when unmapped.
export function normalizeToolName(name, namespace) {
  if (!name) return name
  if (namespace) return `${namespace}__${name}`
  return NATIVE_NAME_MAP[name] || name
}

// Codex native tools name their primary argument differently from Claude's
// built-ins. Alias them onto the keys extractActivityEvents reads
// (file_path / path / command / pattern / …) so the activity card shows a
// useful arg. Only verified tools are mapped; unknown tools pass through and
// still produce a (bare-name) card.
export function aliasNativeArgs(name, input) {
  if (!input || typeof input !== 'object') return input
  switch (name) {
    case 'exec_command':
    case 'shell':
    case 'local_shell':
      // Codex shell: { cmd, workdir, ... } → Claude-style `command`
      if (input.cmd != null && input.command == null) {
        return { ...input, command: Array.isArray(input.cmd) ? input.cmd.join(' ') : input.cmd }
      }
      return input
    default:
      return input
  }
}

// Codex sometimes stores tool output as a transcript wrapper instead of the
// actual payload:
//   Wall time: ...
//   Output:
//   [{"type":"text","text":"..."}]
// Normalize that at parse time so downstream chat/search/render paths see the
// useful result, not the transport envelope. If anything is ambiguous, return
// the original text.
export function unwrapCodexToolOutput(text) {
  return normalizePrettyResult(text)
}

// Parse a Codex `apply_patch` body into the files it touches + their hunks.
// The patch format (verified):
//   *** Begin Patch
//   *** Update File: /abs/path      (or "Add File" / "Delete File" / "Move to: …")
//   @@
//   -old line
//   +new line
//   *** End Patch
// Returns [{ path, op, diff }] — diff is the raw hunk text for that file (the
// +/- lines), so an Edit card can show the change the same way Claude's does.
export function parseApplyPatchFiles(patch) {
  if (typeof patch !== 'string') return []
  const files = []
  let cur = null
  const fileRe = /^\*\*\* (Update|Add|Delete) File: (.+)$/
  const moveRe = /^\*\*\* Move to: (.+)$/
  for (const line of patch.split('\n')) {
    const m = fileRe.exec(line)
    if (m) {
      if (cur) files.push(cur)
      cur = { path: m[2].trim(), op: m[1].toLowerCase(), diff: '' }
      continue
    }
    const mv = moveRe.exec(line)
    if (mv && cur) { cur.movedTo = mv[1].trim(); continue }
    if (line.startsWith('*** End Patch') || line.startsWith('*** Begin Patch')) continue
    if (cur && (line.startsWith('+') || line.startsWith('-') || line.startsWith('@@') || line.startsWith(' '))) {
      cur.diff += (cur.diff ? '\n' : '') + line
    }
  }
  if (cur) files.push(cur)
  return files
}

// Build an assistant event with one Edit tool_use block per file the patch
// touches. file_path drives the daemon's edit attribution + qualification
// checks + the activity card; `diff` carries the hunk for the diff view.
function applyPatchEvent(patchBody, callId, ts) {
  const files = parseApplyPatchFiles(patchBody)
  if (!files.length) {
    // unparseable patch — still surface as a single Edit so it's not lost
    return { type: 'assistant', timestamp: ts, blocks: [{ type: 'tool_use', name: 'Edit', input: { _raw: patchBody }, id: callId }] }
  }
  const blocks = files.map((f, i) => ({
    type: 'tool_use',
    name: 'Edit',
    input: { file_path: f.path, op: f.op, diff: f.diff, ...(f.movedTo ? { movedTo: f.movedTo } : {}) },
    id: (callId || 'patch') + '#' + i,
  }))
  return { type: 'assistant', timestamp: ts, blocks }
}

// Parse one Codex rollout line into the daemon's internal event shape, or null
// to skip. Mirrors parseSessionLine() in fleet-daemon.mjs:
//   assistant tool call → { type:'assistant', blocks:[{type:'tool_use', name, input, id}] }
//   tool output         → { type:'user', blocks:[{type:'tool_result', id, text, is_error}] }
//   assistant text      → { type:'assistant', blocks:[{type:'text', text}] }
//   user input          → { type:'user', blocks:[{type:'text', text}] }  (activity-skipped, search-kept)
//   token usage         → { type:'assistant', usage:{input, output} }
// Codex performs file edits via a distinct `apply_patch` tool that arrives as a
// `custom_tool_call` (NOT function_call) carrying the patch body — we map it to
// one Edit block per file so edits render like Claude's (with the diff), instead
// of vanishing or masquerading as Bash.
export function parseCodexLine(jsonStr) {
  let o
  try { o = JSON.parse(jsonStr) } catch { return null }
  const ts = o.timestamp
  const p = o.payload || {}

  if (o.type === 'response_item') {
    if (p.type === 'function_call') {
      let input = {}
      try { input = p.arguments ? JSON.parse(p.arguments) : {} } catch { input = {} }
      // apply_patch can also surface as a function_call in some Codex builds —
      // route it through the same Edit mapping as the custom_tool_call form.
      if (p.name === 'apply_patch' && !p.namespace) {
        return applyPatchEvent(input.input || input.patch || input.arguments || '', p.call_id, ts)
      }
      const name = normalizeToolName(p.name, p.namespace)
      input = aliasNativeArgs(p.name, input)
      return { type: 'assistant', timestamp: ts, blocks: [{ type: 'tool_use', name, input, id: p.call_id }] }
    }
    if (p.type === 'custom_tool_call') {
      if (p.name === 'apply_patch') {
        const ev = applyPatchEvent(typeof p.input === 'string' ? p.input : '', p.call_id, ts)
        if (ev) return ev
      }
      // unknown custom tool — surface it by (mapped) name so it's at least visible
      const name = NATIVE_NAME_MAP[p.name] || p.name
      const input = typeof p.input === 'string' ? { _raw: p.input } : (p.input || {})
      return { type: 'assistant', timestamp: ts, blocks: [{ type: 'tool_use', name, input, id: p.call_id }] }
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      // output is a string (may carry a "Wall time:\n…Output:\n" preamble).
      const rawText = typeof p.output === 'string' ? p.output
        : (p.output && typeof p.output.content === 'string' ? p.output.content : '')
      const text = unwrapCodexToolOutput(rawText)
      const is_error = /Process exited with code [1-9]/.test(rawText) || /\berror\b/i.test(text.slice(0, 60))
      return { type: 'user', timestamp: ts, blocks: [{ type: 'tool_result', id: p.call_id, text, is_error }] }
    }
    if (p.type === 'message') {
      if (p.role === 'assistant') {
        const text = (p.content || []).filter(c => c && c.type === 'output_text').map(c => c.text).join('')
        if (!text) return null
        return { type: 'assistant', timestamp: ts, blocks: [{ type: 'text', text }] }
      }
      // developer (permissions/skills) and user (env-context wrapper) messages
      // are scaffolding, not agent activity — skip. Real user input arrives as
      // the event_msg 'user_message' below.
      return null
    }
    return null
  }

  if (o.type === 'event_msg') {
    if (p.type === 'user_message') {
      return { type: 'user', timestamp: ts, blocks: [{ type: 'text', text: p.message || '' }] }
    }
    if (p.type === 'token_count') {
      const u = p.info && p.info.last_token_usage
      if (!u) return null
      return {
        type: 'assistant', timestamp: ts,
        usage: { input: u.input_tokens || 0, output: u.output_tokens || 0 },
      }
    }
    // agent_message duplicates the response_item assistant text (same turn) — skip
    // to avoid double-counting. task_started / task_complete carry no activity.
    return null
  }

  // session_meta / turn_context / unknown — skip.
  return null
}
