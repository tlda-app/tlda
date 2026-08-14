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

test('canonical enclosing equation renders as KaTeX instead of literal TeX', () => {
  const oldSource = ['\\begin{equation}', '  x = \\frac{1}{n}\\sum_i a_i.', '\\end{equation}'].join('\n')
  const newSource = ['\\begin{equation}', '  x = \\left|\\frac{1}{n}\\sum_i a_i\\right|.', '\\end{equation}'].join('\n')
  const html = renderEditDiff({
    file_path: 'main.tex', old_string: oldSource, new_string: newSource,
    canonical_source: { before_revision: 'before', after_revision: 'after', scope: { environment: 'equation' } },
  }, ctx)
  const visible = html.replace(/<annotation[\s\S]*?<\/annotation>/g, '')
  assert.match(html, /class="katex/)
  assert.match(html, /<math/)
  assert.match(html, /data-before-revision="before"/)
  assert.doesNotMatch(visible, /\\begin\{equation\}|\\left\||\\right\|/)
})
