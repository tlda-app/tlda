const ROLE_PACK_MARKER = '<!-- fleet-role-pack:v1 -->';

export const NON_CLAUDE_ROLE_PACKS = {
  math: {
    title: 'Math/proof role pack',
    skills: ['writing-process', 'argument-outline', 'proof-smells', 'math-commit-gate'],
    checks: [
      'Treat proof obligations as required, not optional suggestions.',
      'Verify the edited proof or argument on the document surface before reporting done.',
    ],
    workflow: [
      'For paper-writing/source-edit tasks, read the relevant current skills: `writing-process` when writing, and `tooling` only when interpreting tlda errors is actually the task surface.',
      'Do not run `latexmk`, `tlda push`, `tlda build`, or git as routine writing verification; automatic build, push, and versioning should handle it.',
      'If automatic build feedback is missing, stale, or reports success while biber/citations failed, route to a tlda/build owner rather than working around it inside the writing task.',
    ],
  },
  app: {
    title: 'App/UI/fleet role pack',
    skills: ['agent-guide', 'tlda-orientation', 'diagnostic-methodology'],
    checks: [
      'Use browser-visible behavior or fleet-visible artifacts as ground truth.',
      'Do not report fixed/done until the user-visible surface has been checked.',
    ],
    workflow: [
      'For tlda viewer/app work, prefer the project tools named in CLAUDE.md, including tlda-dev pw for browser checks and fleet-visible artifacts for evidence.',
      'Use `tooling` or `tlda-debugging` when build, viewer, or infrastructure behavior is the task surface; do not make those workflows defaults for paper-writing delegates.',
    ],
  },
  guidance: {
    title: 'Guidance/process role pack',
    skills: ['point-dont-paraphrase', 'read-to-the-end', 'investigate-dont-narrate'],
    checks: [
      'Point delegates at canonical guidance instead of paraphrasing it as the source of truth.',
      'If corrected, stop and change course before continuing the prior plan.',
    ],
    workflow: [
      'Project CLAUDE.md can provide context, but if it conflicts with current skills, the current skill wins and stale project guidance should be flagged for cleanup.',
    ],
  },
};

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

export function buildRolePackBlock(role) {
  const pack = NON_CLAUDE_ROLE_PACKS[role];
  if (!pack) return '';
  const skillList = pack.skills.map(skill => `\`${skill}\``).join(', ');
  const checks = pack.checks.map(check => `- ${check}`).join('\n');
  const workflow = (pack.workflow || []).map(hint => `- ${hint}`).join('\n');
  return `${ROLE_PACK_MARKER}
**Non-Claude ${pack.title}**

Before task work, route yourself to the relevant shared skill(s): ${skillList}. Call \`skill\` with no argument if a named skill is unavailable in this harness. Read each applicable skill with \`skill(skill: "<name>")\`, or dismiss it with a specific reason only when it truly does not apply.

Workflow hints:
${workflow}

${checks}`;
}

export function applyNonClaudeRolePack(message, { template, description, successCriteria, harnessKind } = {}) {
  const body = String(message || '');
  if (!isNonClaudeHarness(harnessKind)) return body;
  if (body.includes(ROLE_PACK_MARKER)) return body;

  const role = inferTaskRole({ template, description, message: body, successCriteria });
  const block = buildRolePackBlock(role);
  if (!block) return body;
  return `${block}\n\n---\n\n${body}`;
}
