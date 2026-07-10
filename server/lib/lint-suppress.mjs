// Suppression-pattern lint for code files.
//
// Flags additions like `// @ts-ignore`, empty `catch {}`, `as any`, and skipped
// tests in TS/JS/Python/Ruby diffs. Mirrors the lint-parens / lint-passive
// pattern: lintText for full content, lintDiff for an added-lines view.
//
// Companion to ~/work/dot-claude/skills/code-patterns/SKILL.md (the diagnose-
// don't-suppress classifier) — the skill is the agent-side guidance, this is the
// build-time backstop.
//
// BLOCKING_PATTERNS lists the patterns the pre-commit gate refuses outright when
// a commit ADDS one (net-new, diff-scoped). Everything else stays advisory.

const PATTERNS = [
  // Empty or log-only catch — `catch (e) {}`, `catch {}`, `catch (e) { /* x */ }`,
  // and the pure-logging case `catch (e) { log.error(...) }` / `console.error(...)`.
  // A body that is ONLY a comment and/or log calls swallows every error — failed
  // migrations, wrong types, network outages — while looking handled. `console.error`
  // and the app's `log.<lvl>`/`logger.<lvl>` (per project logging guidance, how server/fleet code
  // logs) are the dominant swallow form, so they count too. A catch that logs and
  // then rethrows/returns/recovers has a non-log statement in its body → not matched.
  //
  // Escape hatch (mirrors the ts-ignore/eslint-disable "give a reason" rule): a
  // catch whose body carries a real reason comment (≥2 meaningful words) is exempt —
  // `catch { /* best-effort: pid may already be dead */ }` passes; bare `catch {}`
  // and `catch { /* ignore */ }` do not. See `exempt` below.
  {
    name: 'empty-or-log-only-catch',
    description: 'catch with empty body or log-only body silently swallows every error — including ones that signal real bugs. Handle the error, rethrow it, or (if swallowing is genuinely correct) add a comment explaining why.',
    regex: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*|(?:console\.(?:log|warn|debug|error)|(?:log|logger)\.(?:trace|debug|info|warn|error|fatal))\([^)]*\)\s*;?\s*)*\}/g,
    // Exempt a catch whose body explains WHY the swallow is deliberate. A real
    // reason = a comment with ≥2 words that aren't filler ("ignore", "noop", …).
    exempt: (matchText) => {
      const comments = [...matchText.matchAll(/\/\/([^\n]*)|\/\*([\s\S]*?)\*\//g)]
        .map((c) => (c[1] || c[2] || '').trim())
      const FILLER = new Set(['ignore', 'ignored', 'ignores', 'empty', 'noop', 'nothing',
        'skip', 'skipped', 'pass', 'todo', 'fixme', 'catch', 'error', 'err', 'swallow'])
      return comments.some((c) => {
        const words = c.replace(/[^a-zA-Z]+/g, ' ').trim().split(/\s+/).filter((w) => w.length > 2)
        const meaningful = words.filter((w) => !FILLER.has(w.toLowerCase()))
        return meaningful.length >= 2
      })
    },
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

// Patterns the pre-commit gate BLOCKS on when a commit adds one (net-new only —
// legacy hits stay advisory because the gate is diff-scoped). Scoped to the
// JS/TS error-swallowing catch: "exceptions bubble" is the rule with teeth, and
// this pattern has a humane reason-comment escape (see `exempt`). The other
// patterns — including python-bare-except-pass — stay advisory for now: blocking
// `except OSError: pass` (a legit best-effort idiom) with no reason-escape would
// just nag. Adding an exempt + blocking for Python is a clean follow-up.
export const BLOCKING_PATTERNS = new Set(['empty-or-log-only-catch'])

// Lint a full text. Returns [{file, line, pattern, snippet, description}].
export function lintText(text, file = '<text>') {
  const results = []
  // Skip lint files themselves and their tests — they have to mention these
  // patterns in regexes / strings without flagging.
  if (/lint-suppress\.|lint-suppress$/i.test(file)) return results
  if (/\.test\.|spec\./i.test(file) && /test-skip|empty-catch/.test(file)) return results

  for (const { name, regex, description, exempt } of PATTERNS) {
    regex.lastIndex = 0
    let m
    while ((m = regex.exec(text)) !== null) {
      // A pattern may exempt a match (e.g. a catch that explains its swallow).
      if (exempt && exempt(m[0])) continue
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

// Generated / vendored / runtime-data paths that contain code-shaped files but
// aren't hand-authored source — linting them is noise. mcp-server/fleet-data/ is
// the fleet upload store (timestamped build/sync snapshots agents upload); dist
// and bundles are build output.
const NON_SOURCE_PATHS = /(?:^|\/)(?:dist|node_modules|fleet-data\/uploads|fleet-data)\/|\.min\.[cm]?js$/

// Lint a unified diff against the post-state file contents.
// `diffText` — `git diff --cached` or `git diff HEAD~1 HEAD` output.
// `readFile(path)` — function returning post-state file contents (or null).
// Returns flat array of lint results with file/line/pattern/snippet/description.
export function lintDiff(diffText, readFile) {
  const addedByFile = parseDiffAddedLines(diffText)
  const results = []
  for (const [file, addedLines] of addedByFile.entries()) {
    if (!CODE_EXTS.test(file)) continue
    if (NON_SOURCE_PATHS.test(file)) continue
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
export function formatFindings(findings, { blocking = false } = {}) {
  if (findings.length === 0) return ''
  const byFile = new Map()
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, [])
    byFile.get(f.file).push(f)
  }
  const blocked = findings.filter((f) => BLOCKING_PATTERNS.has(f.pattern))
  const header = blocked.length > 0
    ? `${blocking ? '✖' : '⚠'} Suppression-pattern lint — ${findings.length} flagged (${blocked.length} swallow-the-error):`
    : `⚠ Suppression-pattern lint — ${findings.length} flagged:`
  const lines = [header]
  for (const [file, items] of byFile.entries()) {
    lines.push(``)
    lines.push(`  ${file}`)
    for (const f of items) {
      const mark = BLOCKING_PATTERNS.has(f.pattern) ? '✖' : '·'
      lines.push(`    ${mark} L${f.line} [${f.pattern}]  ${f.snippet}`)
    }
  }
  lines.push(``)
  if (blocked.length > 0) {
    lines.push(blocking
      ? `✖ BLOCKED: this commit adds an error-swallowing catch. Exceptions must bubble.`
      : `⚠ The ✖ lines swallow errors — these BLOCK at commit time (pre-commit gate).`)
    lines.push(`  Fix it: handle the error, rethrow, or recover. If swallowing is genuinely`)
    lines.push(`  correct (e.g. a best-effort liveness probe), add a comment saying WHY`)
    lines.push(`  (≥2 words) inside the catch body — that exempts it.${blocking ? ' Last resort: --no-verify.' : ''}`)
    lines.push(``)
  }
  lines.push(`Each one is the cheap version of a fix. Read ~/work/dot-claude/skills/code-patterns/SKILL.md before suppressing — most are real bugs, dead code, or API drift.`)
  return lines.join('\n')
}
