import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import ts from 'typescript'

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
        .map(assertion => ({ text: assertion.message, line: assertion.line })),
    )
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
    return node.templateSpans.reduce(
      (text, span) => `${text}\${${span.expression.getText(sourceFile)}}${span.literal.text}`,
      node.head.text,
    )
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
