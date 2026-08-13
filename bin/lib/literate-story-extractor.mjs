import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import ts from 'typescript'

// An assertion message carries two halves: the state, and what it costs a
// person that the state is wrong.
//
//   'the paper — r3 has Bob's note; otherwise Bob's edit to notes.tex was lost'
//
// Both halves reach a failing reader, because `expected 'bob notes' to equal ''`
// does not tell anybody Bob lost work. The catalogue takes the state and stops
// at `; otherwise`. That split is the tool's job, not the author's — authors
// write both halves, always.
export const LITERATE_STORY_LIMITS = [
  'Only `// ##` story comments and `// ###` step comments in test files are story structure.',
  'A `// ###` step with `assert.*` messages under it contributes their state lines. A step with none is an action — the server dies, Alice pushes — and renders as itself; its consequences belong to the step that follows.',
  'Assertions hidden inside helpers do not appear in the catalogue; add a visible step assertion for the state the helper proves.',
  'Bare assertions with no message do not appear; story assertions need a reader-facing state message.',
  'Assertion messages must be plain strings or concatenated plain strings; interpolation is refused because source values belong to assert output, not the catalogue.',
  'An assertion message is `state; otherwise consequence`. The failing output gets the whole string — a red has to say what a person lost, not just which value differed. The catalogue keeps the state and cuts at `; otherwise`.',
  'Custom assertion wrappers and non-`assert` libraries are not inspected.',
  // A story line says what the app did. A precondition or control says the test
  // was capable of failing. They read identically in `subject — state` form and
  // mean opposite things: "the server process — dies inside the source
  // transaction" looks like behaviour under test, and a reader whose eye lands
  // on it goes hunting for a rollback bug that is not there. It was setup being
  // verified.
  'A precondition or control is not a story line. It asserts the test could have failed — that the crash really killed the process, that the deleted blob is really unreadable, that the push really reached the server — rather than anything the app promises.',
  'Preconditions and controls keep their consequence in the message, because that consequence is what tells a reader a failure means the run proved nothing rather than the product is broken. The state-only rule is for story lines.',
]
/**
 * The catalogue line: everything before `; otherwise`. The consequence after it
 * belongs to whoever is reading a failure, not to somebody reading the stories
 * as prose.
 */
export function catalogueLine(message) {
  const cut = message.indexOf('; otherwise')
  return (cut === -1 ? message : message.slice(0, cut)).trim()
}

const TEST_DIRS = ['bin', 'tests', 'test', 'scripts', 'server', 'shared', 'daemon', 'packages', 'mcp-server']
const TEST_FILE = /(?:^|[-.])test\.(?:mjs|js|ts)$/
const HEADING_COMMENT_RE = /^\s*\/\/\s*(#{2,3})\s+(.+?)\s*$/

export function discoverStoryTestFiles(rootDir) {
  const files = []
  const visit = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'scratch' || entry.name === '.git') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && TEST_FILE.test(entry.name) && fileHasStoryHeadings(full)) files.push(full)
    }
  }
  for (const dir of TEST_DIRS) {
    const full = join(rootDir, dir)
    if (existsSync(full)) visit(full)
  }
  return files.sort()
}

function fileHasStoryHeadings(file) {
  return readFileSync(file, 'utf8').split('\n').some(line => HEADING_COMMENT_RE.test(line))
}

export function extractStoriesFromFile(file, rootDir = process.cwd()) {
  return extractStories(readFileSync(file, 'utf8'), relative(rootDir, file))
}

export function extractStories(source, file = '<inline>') {
  const lines = source.split('\n')
  const headings = commentHeadings(source)
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const assertions = assertionMessages(sourceFile)
  const stories = []
  let currentStory = null
  let currentStep = null

  for (const heading of headings) {
    if (heading.level === 2) {
      currentStory = { title: heading.title, file, line: heading.line, steps: [] }
      stories.push(currentStory)
      currentStep = null
      continue
    }
    if (!currentStory) continue
    currentStep = { title: heading.title, line: heading.line, states: [] }
    currentStory.steps.push(currentStep)
    const endLine = Math.min(nextHeadingLine(headings, heading), nextBlockBoundaryLine(lines, heading))
    currentStep.states.push(
      ...assertions
        .filter(assertion => assertion.line > heading.line && assertion.line < endLine)
        .map(assertion => {
          if (assertion.message.includes('${')) {
            throw new Error(`${file}:${assertion.line}: assertion message contains interpolation and cannot be a story line: ${assertion.message}`)
          }
          return { text: catalogueLine(assertion.message), line: assertion.line }
        }),
    )
    // A step with no assertions is an ACTION — "the server dies before the
    // checkpoint", "Alice pushes", "Carol types" — whose consequences are
    // asserted in the step after it. That is correct writing, so it renders as
    // itself with nothing under it and a reader reads on.
    //
    // It used to throw, and the throw took the whole catalogue down: one
    // unusual step and nine stories emitted nothing. A tool whose job is to
    // produce a readable list must never answer "nothing" because one entry
    // surprised it. An empty step is visible in the output — which is also the
    // honest report of a step that lost its assertions — and a hard throw is
    // not.
  }
  return stories.filter(story => story.steps.length)
}

function commentHeadings(source) {
  return source.split('\n').flatMap((line, index) => {
    const match = line.match(HEADING_COMMENT_RE)
    if (!match) return []
    return [{ level: match[1].length, title: match[2].trim(), line: index + 1, indent: line.search(/\S/) }]
  })
}

function nextHeadingLine(headings, heading) {
  const next = headings.find(candidate => candidate.line > heading.line && candidate.level <= heading.level)
  return next?.line ?? Number.POSITIVE_INFINITY
}

function nextBlockBoundaryLine(lines, heading) {
  for (let i = heading.line; i < lines.length; i++) {
    const line = lines[i]
    if (!line || /^\s*\/\//.test(line)) continue
    const indent = line.search(/\S/)
    if (indent >= 0 && indent < heading.indent) return i + 1
  }
  return Number.POSITIVE_INFINITY
}

function assertionMessages(sourceFile) {
  const messages = []
  const visit = node => {
    if (ts.isCallExpression(node) && isAssertCall(node)) {
      const last = node.arguments[node.arguments.length - 1]
      const message = staticString(last, sourceFile)
      if (message) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        messages.push({ line: line + 1, message })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return messages
}

function isAssertCall(node) {
  const expression = node.expression
  if (!ts.isPropertyAccessExpression(expression)) return false
  return ts.isIdentifier(expression.expression) && expression.expression.text === 'assert'
}

function staticString(node, sourceFile) {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left, sourceFile)
    const right = staticString(node.right, sourceFile)
    if (left != null && right != null) return left + right
  }
  if (ts.isTemplateExpression(node)) {
    return `${node.head.text}\${${node.templateSpans[0]?.expression.getText(sourceFile) ?? '...'}}`
  }
  return null
}

export function renderStoriesMarkdown(stories) {
  return stories.map(story => {
    const lines = [`## ${story.title}`]
    for (const step of story.steps) {
      lines.push('', `### ${step.title}`)
      for (const state of step.states) lines.push(state.text)
    }
    return lines.join('\n')
  }).join('\n\n')
}
