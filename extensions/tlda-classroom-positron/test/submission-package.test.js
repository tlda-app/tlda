const assert = require('node:assert/strict')
const test = require('node:test')
const { strFromU8, unzipSync } = require('fflate')
const { buildSubmissionArchive, parseQmdReferences, safeRelativeAsset } = require('../submission-package')

const qmd = `---
title: Homework
---

::: {#ans-one}
My answer.
:::

\`![](example.png)\`

\`\`\`markdown
![](also-example.png)
\`\`\`

![](photo one.png)
![](figs/plot.png)
`

test('references match the server rules and ignore shown code', () => {
  assert.deepEqual(parseQmdReferences(qmd), {
    images: ['photo', 'figs/plot.png'],
    answerIds: ['ans-one'],
  })
})

test('builds one QMD plus each unique referenced asset', async () => {
  const source = qmd.replace('photo one.png', 'photo.png')
  const assets = new Map([
    ['photo.png', new Uint8Array([1, 2, 3])],
    ['figs/plot.png', new Uint8Array([4, 5])],
  ])
  const result = await buildSubmissionArchive({
    qmdName: 'homework.qmd',
    source,
    readAsset: async name => assets.get(name),
  })
  const unpacked = unzipSync(result.bytes)
  assert.deepEqual(Object.keys(unpacked).sort(), ['figs/plot.png', 'homework.qmd', 'photo.png'])
  assert.equal(strFromU8(unpacked['homework.qmd']), source)
  assert.deepEqual([...unpacked['photo.png']], [1, 2, 3])
})

test('refuses a missing image with a student-facing message', async () => {
  await assert.rejects(
    buildSubmissionArchive({
      qmdName: 'homework.qmd',
      source: qmd.replace('photo one.png', 'missing.png'),
      readAsset: async name => {
        if (name === 'missing.png') throw Object.assign(new Error('missing'), { code: 'FileNotFound' })
        return new Uint8Array()
      },
    }),
    /missing\.png, but that file is missing/
  )
})

test('refuses documents without answer blocks', async () => {
  await assert.rejects(
    buildSubmissionArchive({ qmdName: 'notes.qmd', source: '# Notes\n', readAsset: async () => new Uint8Array() }),
    /no answer blocks/
  )
})

test('refuses assets outside the assignment folder', () => {
  assert.throws(() => safeRelativeAsset('../secret.png'), /leaves the assignment folder/)
  assert.throws(() => safeRelativeAsset('/tmp/secret.png'), /leaves the assignment folder/)
})
