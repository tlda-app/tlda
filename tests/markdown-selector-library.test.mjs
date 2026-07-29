import assert from 'node:assert/strict'
import test from 'node:test'
import { filterMarkdown, selectMarkdown } from '../shared/markdown-selector.mjs'

test('filters Pandoc-tagged sections while returning Markdown', () => {
  const source = `---
name: example
---

# Shared

Shared text.

## App only {.app}

App text.

## Claude only {.claude}

Claude text.
`
  const { body } = filterMarkdown(source, { drop: ':is(.app, .claude)' })
  assert.match(body, /^---\nname: example\n---/)
  assert.match(body, /# Shared\n\nShared text\./)
  assert.doesNotMatch(body, /App only|App text|Claude only|Claude text/)
})

test('selects structural Markdown by heading id and CSS selectors', () => {
  const source = `# Project

Intro.

## First pass {.app}

First body.

### Detail

Detail body.

## Second pass {.math}

Second body.
`
  assert.equal(
    selectMarkdown(source, '#first-pass').body,
    `## First pass {.app}

First body.

### Detail

Detail body.`,
  )
  assert.equal(
    selectMarkdown(source, '.math').body,
    `## Second pass {.math}

Second body.`,
  )
  assert.equal(selectMarkdown(source, '.app > p').body, 'First body.')
})
