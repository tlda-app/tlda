export const LANE_BLOCK_OVERRIDE = 'cross-lane-ok:';

const LANE_PATTERNS = [
  ['guidance', /\b(guidance|prompt|skill|claude|codex|contract|role[- ]?pack|dot-claude)\b/i],
  ['app', /\b(tlda|fleet|viewer|ui|ux|app|server|daemon|mcp|spawn|codex|goose|ops)\b/i],
  ['math', /\b(math|proof|paper|theorem|lemma|proposition|corollary|latex|tex|writing|review)\b/i],
];

export function inferAgentLane(agent = {}) {
  if (agent.human) return 'human';
  const labels = Array.isArray(agent.labels) ? agent.labels.join(' ') : '';
  const text = [
    agent.friendly_name,
    labels,
    agent.cwd,
    agent.project,
  ].filter(Boolean).join(' ');

  if (/\/work\/dot-claude(?:\/|$)/.test(text) || /\bdot-claude\b/i.test(text)) return 'guidance';
  if (/\/work\/tlda(?:\/|$)/.test(text) || /\/work\/published\/tlda(?:\/|$)/.test(text)) return 'app';

  for (const [lane, pattern] of LANE_PATTERNS) {
    if (pattern.test(text)) return lane;
  }
  return null;
}

export function lanesMayCoordinate(fromLane, toLane) {
  if (!fromLane || !toLane) return true;
  if (fromLane === 'human' || toLane === 'human') return true;
  if (fromLane === toLane) return true;
  // Guidance work often needs app/dev implementation, and app/dev may ask
  // guidance agents about the contract they are implementing.
  if ((fromLane === 'guidance' && toLane === 'app') || (fromLane === 'app' && toLane === 'guidance')) return true;
  return false;
}

export function looksLikeManagementMessage(message) {
  const text = String(message || '');
  return /\b(you need to|please|do not|don't|stop|fix|implement|delegate|spawn|coordinate|route|correct|read|verify|mark .*done|task_done|report|take care of|handle this)\b/i.test(text);
}

export function crossLaneBlock({ fromAgent, toAgent, action, message, directReply = false } = {}) {
  if (directReply) return null;
  if (String(message || '').includes(LANE_BLOCK_OVERRIDE)) return null;

  const fromLane = inferAgentLane(fromAgent);
  const toLane = inferAgentLane(toAgent);
  if (lanesMayCoordinate(fromLane, toLane)) return null;

  if (action === 'chat' && !looksLikeManagementMessage(message)) return null;

  const fromName = fromAgent?.friendly_name || fromAgent?.id || 'caller';
  const toName = toAgent?.friendly_name || toAgent?.id || 'target';
  return {
    fromLane,
    toLane,
    text: `Cross-lane ${action} blocked: ${fromName} (${fromLane || 'unknown lane'}) -> ${toName} (${toLane || 'unknown lane'}). Direct replies are allowed; guidance<->app coordination is allowed. If Skip explicitly authorized this cross-lane action, include "${LANE_BLOCK_OVERRIDE}" in the message and state the authorization.`,
  };
}

const ROLE_PATTERNS = [
  ['math', /\b(math|proof|theorem|lemma|proposition|corollary|latex|tex|paper|argument|derive|bound|assumption|notation)\b/i],
  ['guidance', /\b(guidance|contract|skill|role[- ]?pack|prompt|delegate|delegation|startup|instructions?|process|handoff)\b/i],
  ['app', /\b(app|ui|ux|browser|playwright|screenshot|visual|frontend|react|tldraw|viewer|fleet|mcp|server|daemon|spawn|codex|goose|artifact|evidence)\b/i],
];

export function inferTaskRole({ template, description, message, successCriteria } = {}) {
  if (template === 'math-edit') return 'math';

  const text = [
    description,
    message,
    ...(Array.isArray(successCriteria) ? successCriteria : []),
  ].filter(Boolean).join('\n');

  for (const [role, pattern] of ROLE_PATTERNS) {
    if (pattern.test(text)) return role;
  }
  return null;
}

export function inferHarnessKind({ kind, model } = {}) {
  const requested = String(kind || '').toLowerCase();
  if (['claude', 'codex', 'goose'].includes(requested)) return requested;

  const selected = String(model || '').toLowerCase();
  if (/^(gpt|o[0-9]|codex)\b/.test(selected) || selected.includes('gpt-5.5')) return 'codex';
  if (selected.includes('/') || selected.startsWith('deepseek') || selected.startsWith('kimi') || selected.startsWith('qwen') || selected.startsWith('glm') || selected.startsWith('minimax') || selected.startsWith('mistral')) return 'goose';
  return null;
}

export function isNonClaudeHarness(kind) {
  return kind === 'codex' || kind === 'goose';
}

export function applyNonClaudeRolePack(message, { template, description, successCriteria, harnessKind } = {}) {
  return String(message || '');
}
