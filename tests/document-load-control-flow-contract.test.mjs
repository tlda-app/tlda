import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const projectsRoute = await readFile(new URL('../server/routes/projects.mjs', import.meta.url), 'utf8')

test('picker selection reuses its existing project config', () => {
  assert.match(app, /onSelect=\{\(key, config\) => \{[\s\S]*loadDocument\(key, roomId, config\)/)
  assert.match(app, /loadDocument\(name, roomId, manifest\[name\]\)/)
})

test('direct URLs request config and page info together', () => {
  assert.match(app, /loadDocument\(projectName, roomId, undefined, true\)/)
  assert.match(app, /includePageInfo \? '\?include=page-info' : ''/)
  assert.match(app, /config\.pageInfo[\s\S]*createHtmlDocumentFromPageInfo/)
  assert.match(projectsRoute, /req\.query\.include === 'page-info'/)
  assert.match(projectsRoute, /\.\.\.\(pageInfo && \{ pageInfo \}\)/)
})

test('legacy diff documents and global sourceDoc lookup stay absent', () => {
  assert.doesNotMatch(app, /loadDiffDocument|sourceDoc|format === 'diff'|format !== 'diff'/)
})
