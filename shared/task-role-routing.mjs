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

export function isNonClaudeHarness(kind) {
  return kind === 'codex' || kind === 'goose';
}

export function applyNonClaudeRolePack(message, { template, description, successCriteria, harnessKind } = {}) {
  return String(message || '');
}
