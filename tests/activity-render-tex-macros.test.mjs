import test from 'node:test'
import assert from 'node:assert/strict'
import { renderEditDiff } from '../src/fleet/activity-render.mjs'

const ctx = {
  langFromFilePath: () => '',
  highlightSyntax: (code) => code,
  preambleMacros: {
    '\\foo': '\\mathbb{R}',
    '\\barop': '\\operatorname{bar}',
  },
}

test('tex edit diffs render multiline display math with project macros', () => {
  const html = renderEditDiff({
    file_path: 'main.tex',
    old_string: [
      'Before',
      '\\[',
      '  \\foo + \\barop(x)',
      '\\]',
    ].join('\n'),
    new_string: [
      'After',
      '\\[',
      '  \\barop(x) = \\foo',
      '\\]',
    ].join('\n'),
  }, ctx)

  assert.match(html, /class="katex/)
  assert.match(html, /mathbb">R/)
  assert.match(html, /mord mathrm">bar/)
  assert.doesNotMatch(html.replace(/<annotation[\s\S]*?<\/annotation>/g, ''), /\\foo|\\barop/)
})
