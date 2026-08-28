const assert = require('node:assert/strict')
const test = require('node:test')
const { buildSubmissionArchive } = require('../submission-package')
const { handlesImage, planImageDrop } = require('../image-drop')

const DIR = '/Users/student/qtm285/hw-minus-1'

test('claims the camera formats Quarto does not treat as images', () => {
  for (const name of ['IMG_0001.HEIC', 'photo.heic', 'photo.heif', 'photo.avif']) {
    assert.equal(handlesImage(name), true, name)
  }
  // Quarto already emits `![](…)` for these; taking them over would change a path that works.
  for (const name of ['photo.png', 'photo.JPG', 'plot.svg', 'photo.webp', 'notes.pdf', 'data.csv']) {
    assert.equal(handlesImage(name), false, name)
  }
})

test('a photo dropped from Photos is embedded and copied beside the document', () => {
  const plan = planImageDrop({ docDir: DIR, dropped: [{ fsPath: '/Users/student/Pictures/IMG_0001.HEIC' }] })
  assert.equal(plan.markdown, '![${1:Alt text}](IMG_0001.HEIC)')
  assert.deepEqual(plan.copies, [{ from: '/Users/student/Pictures/IMG_0001.HEIC', to: `${DIR}/IMG_0001.HEIC` }])
})

test('a photo already beside the document is embedded without copying it onto itself', () => {
  const plan = planImageDrop({ docDir: DIR, dropped: [{ fsPath: `${DIR}/IMG_0001.HEIC` }] })
  assert.equal(plan.markdown, '![${1:Alt text}](IMG_0001.HEIC)')
  assert.deepEqual(plan.copies, [])
})

test('a second photo of the same name does not overwrite the first', () => {
  const plan = planImageDrop({
    docDir: DIR,
    dropped: [{ fsPath: '/Volumes/iPhone/IMG_0001.HEIC' }],
    taken: name => name === 'IMG_0001.HEIC',
  })
  assert.equal(plan.markdown, '![${1:Alt text}](IMG_0001-1.HEIC)')
  assert.deepEqual(plan.copies, [{ from: '/Volumes/iPhone/IMG_0001.HEIC', to: `${DIR}/IMG_0001-1.HEIC` }])
})

test('several photos dropped together get distinct names and their own placeholders', () => {
  const plan = planImageDrop({
    docDir: DIR,
    dropped: [{ fsPath: '/a/IMG_0001.HEIC' }, { fsPath: '/b/IMG_0001.HEIC' }],
  })
  assert.equal(plan.markdown, '![${1:Alt text}](IMG_0001.HEIC) ![${2:Alt text}](IMG_0001-1.HEIC)')
  assert.deepEqual(plan.copies.map(copy => copy.to), [`${DIR}/IMG_0001.HEIC`, `${DIR}/IMG_0001-1.HEIC`])
})

test('a name with spaces stays usable as a markdown target', () => {
  const plan = planImageDrop({ docDir: DIR, dropped: [{ fsPath: '/a/my photo.heic' }] })
  assert.equal(plan.markdown, '![${1:Alt text}](my%20photo.heic)')
})

test('yields to Quarto when nothing dropped is ours', () => {
  assert.equal(planImageDrop({ docDir: DIR, dropped: [{ fsPath: '/a/photo.png' }] }), null)
  assert.equal(planImageDrop({ docDir: DIR, dropped: [] }), null)
})

// The whole point of the change: what the provider writes must be what packaging collects.
test('what the provider inserts is what the submission ZIP carries', async () => {
  const plan = planImageDrop({ docDir: DIR, dropped: [{ fsPath: '/Users/student/Pictures/IMG_0001.HEIC' }] })
  const inserted = plan.markdown.replace(/\$\{\d+:([^}]*)\}/g, '$1')
  const source = `---\ntitle: HW\n---\n\n::: {#ans-photo}\n${inserted}\n:::\n`

  const archive = await buildSubmissionArchive({
    qmdName: 'hw.qmd',
    source,
    readAsset: async () => new Uint8Array([1, 2, 3]),
  })
  assert.deepEqual(archive.files, ['hw.qmd', 'IMG_0001.HEIC'])

  // The control, and the defect this fixes: Quarto's own insert for the same file is a link,
  // and packaging correctly ignores a link, so the photo never reaches the server.
  const quartoInsert = source.replace('![Alt text]', '[label]')
  const quartoArchive = await buildSubmissionArchive({
    qmdName: 'hw.qmd',
    source: quartoInsert,
    readAsset: async () => new Uint8Array([1, 2, 3]),
  })
  assert.deepEqual(quartoArchive.files, ['hw.qmd'])
})
