// Suppression-pattern lint for code files.
//
// Flags additions like `// @ts-ignore`, empty `catch {}`, `as any`, and skipped
// tests in TS/JS/Python/Ruby diffs. Mirrors the lint-parens / lint-passive
// pattern: lintText for full content, lintDiff for an added-lines view.
//
// Companion to ~/work/dot-claude/skills/diagnose-not-suppress/SKILL.md — the
// skill is the agent-side guidance, this is the build-time backstop.

const PATTERNS = [
  // Empty catch — `catch (e) {}`, `catch {}`, `catch (e) { /* ignored */ }`.
  // We also catch the pure-logging case ("catch and console.log" — usually a
  // mistake too: surface log lines should be specific, not "something failed").
  {
    name: 'empty-catch',
    description: 'catch with empty body or pure-log body silently swallows every error — including ones that signal real bugs (failed migrations, wrong types, network outages).',
    regex: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*|console\.(?:log|warn|debug)\([^)]*\)\s*;?\s*)*\}/g,
  },
  // @ts-ignore or @ts-expect-error without a reason. Acceptable form requires
  // " — " or "TODO" or a reason after the directive.
  {
    name: 'ts-ignore-no-reason',
    description: '`@ts-ignore` / `@ts-expect-error` without a reason. Required form: `// @ts-expect-error <what is broken; why suppress; when to remove>`.',
    regex: /\/\/\s*@ts-(?:ignore|expect-error)(?:\s*$|\s+(?!.*[—:-])\S*$)/gm,
  },
  // eslint-disable without a reason. Same standard: must explain.
  {
    name: 'eslint-disable-no-reason',
    description: '`// eslint-disable*` without a reason. Required form: `// eslint-disable-next-line <rule> -- <why>`.',
    regex: /\/\/\s*eslint-disable(?:-next-line|-line)?\s+[\w/-]+(?:\s*,\s*[\w/-]+)*\s*$/gm,
  },
  // Casting to any — newly added `as any` is almost always covering up
  // a type mismatch that should be diagnosed.
  {
    name: 'as-any',
    description: '`as any` cast. Usually a sign that you are dodging a type error rather than understanding it. Either use the right type, or document why the cast is necessary.',
    regex: /\bas\s+any\b/g,
  },
  // Test suppression. .skip on test/it/describe; xfail / xit; pytest.mark.skip.
  {
    name: 'test-skip',
    description: 'Test marked as skipped/expected-fail. If the test is broken, fix it; if it is irrelevant, delete it. Long-lived skips rot.',
    regex: /\b(?:it|test|describe|context)\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\bpytest\.mark\.(?:skip|xfail)\b|\bxfail\b/g,
  },
  // Python pass-only except — `except: pass` or `except Exception: pass`.
  {
    name: 'python-bare-except-pass',
    description: '`except: pass` / `except Exception: pass` swallows every exception. Catch a specific exception type and do something deliberate, or let it propagate.',
    regex: /\bexcept(?:\s+\w+(?:\s+as\s+\w+)?)?\s*:\s*\n\s*pass\b/g,
  },
]

// Lint a full text. Returns [{file, line, pattern, snippet, description}].
export function lintText(text, file = '<text>') {
  const results = []
  // Skip lint files themselves and their tests — they have to mention these
  // patterns in regexes / strings without flagging.
  if (/lint-suppress\.|lint-suppress$/i.test(file)) return results
  if (/\.test\.|spec\./i.test(file) && /test-skip|empty-catch/.test(file)) return results

  for (const { name, regex, description } of PATTERNS) {
    regex.lastIndex = 0
    let m
    while ((m = regex.exec(text)) !== null) {
      // Compute the line number from the match offset.
      const before = text.slice(0, m.index)
      const line = before.split('\n').length
      const snippet = m[0].slice(0, 80).replace(/\s+/g, ' ').trim()
      results.push({ file, line, pattern: name, snippet, description })
    }
  }
  return results
}

// Parse a unified diff and return only the added lines per file with their
// new-file line numbers. Returns Map<file, Set<lineNumber>>.
function parseDiffAddedLines(diffText) {
  const out = new Map()
  let curFile = null
  let curLine = 0
  let added
  for (const l of diffText.split('\n')) {
    const fileMatch = l.match(/^\+\+\+ (?:b\/)?(.+)$/)
    if (fileMatch) {
      curFile = fileMatch[1]
      added = new Set()
      out.set(curFile, added)
      continue
    }
    if (!added) continue
    const hunk = l.match(/^@@ [^+]*\+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      curLine = parseInt(hunk[1], 10)
      continue
    }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      added.add(curLine)
      curLine++
    } else if (l.startsWith('-') && !l.startsWith('---')) {
      // doesn't advance new-file line
    } else if (!l.startsWith('\\')) {
      curLine++
    }
  }
  return out
}

const CODE_EXTS = /\.(ts|tsx|js|mjs|cjs|jsx|py|rb)$/

// Lint a unified diff against the post-state file contents.
// `diffText` — `git diff --cached` or `git diff HEAD~1 HEAD` output.
// `readFile(path)` — function returning post-state file contents (or null).
// Returns flat array of lint results with file/line/pattern/snippet/description.
export function lintDiff(diffText, readFile) {
  const addedByFile = parseDiffAddedLines(diffText)
  const results = []
  for (const [file, addedLines] of addedByFile.entries()) {
    if (!CODE_EXTS.test(file)) continue
    let content
    try { content = readFile(file) } catch { content = null }
    if (!content) continue
    const allFindings = lintText(content, file)
    for (const finding of allFindings) {
      if (addedLines.has(finding.line)) results.push(finding)
    }
  }
  return results
}

// Format findings for human display (CLI / chat). Groups by file, includes
// a one-line per finding with line number + pattern + snippet, then a short
// pointer to the skill at the end.
export function formatFindings(findings) {
  if (findings.length === 0) return ''
  const byFile = new Map()
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, [])
    byFile.get(f.file).push(f)
  }
  const lines = [`⚠ Suppression-pattern lint — ${findings.length} flagged:`]
  for (const [file, items] of byFile.entries()) {
    lines.push(``)
    lines.push(`  ${file}`)
    for (const f of items) {
      lines.push(`    L${f.line} [${f.pattern}]  ${f.snippet}`)
    }
  }
  lines.push(``)
  lines.push(`Each one is the cheap version of a fix. Read ~/work/dot-claude/skills/diagnose-not-suppress/SKILL.md before suppressing — most are real bugs, dead code, or API drift.`)
  return lines.join('\n')
}
