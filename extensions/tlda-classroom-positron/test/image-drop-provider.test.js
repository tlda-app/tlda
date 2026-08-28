const assert = require('node:assert/strict')
const test = require('node:test')
const Module = require('node:module')
const path = require('node:path')

// extension.js requires `vscode`, which only exists inside the editor host. Standing a stub in
// front of it exercises OUR glue — uri-list parsing, the sibling scan, the snippet, and the
// createFile edits that copy the photo. What it cannot prove is that the editor invokes us or
// that our edit beats Quarto's; that ordering is argued from the editor's source, not measured.
function installVscodeStub(stub) {
  const load = Module._load
  Module._load = (request, ...rest) => (request === 'vscode' ? stub : load(request, ...rest))
  return () => { Module._load = load }
}

const uri = fsPath => ({ scheme: 'file', path: fsPath, fsPath, toString: () => `file://${fsPath}` })

function makeStub({ siblings = [], bytes = new Uint8Array([9, 9]) } = {}) {
  const created = []
  return {
    created,
    stub: {
      Uri: {
        parse: value => {
          if (!value.startsWith('file://')) return { scheme: value.split(':')[0], path: value }
          return uri(decodeURIComponent(value.slice('file://'.length)))
        },
        joinPath: (base, ...parts) => uri(path.posix.normalize(path.posix.join(base.path, ...parts))),
      },
      workspace: {
        fs: {
          readDirectory: async () => siblings.map(name => [name, 1]),
          readFile: async () => bytes,
        },
      },
      SnippetString: class { constructor(value) { this.value = value } },
      DocumentDropEdit: class { constructor(insertText) { this.insertText = insertText } },
      WorkspaceEdit: class {
        constructor() { this.edits = [] }
        createFile(target, options) { this.edits.push({ target: target.path, options }); created.push(target.path) }
      },
      languages: { registerDocumentDropEditProvider: () => ({ dispose() {} }) },
      commands: { registerCommand: () => ({ dispose() {} }) },
      extensions: { getExtension: () => undefined },
      window: {},
    },
  }
}

const token = { isCancellationRequested: false }
const dataTransfer = list => ({ get: type => (type === 'text/uri-list' ? { asString: async () => list } : undefined) })
const doc = { uri: uri('/Users/student/qtm285/hw-minus-1/hw.qmd') }

async function drop(list, options) {
  const { stub, created } = makeStub(options)
  const restore = installVscodeStub(stub)
  try {
    delete require.cache[require.resolve('../extension')]
    const { imageDropProvider } = require('../extension')
    const edit = await imageDropProvider.provideDocumentDropEdits(doc, null, dataTransfer(list), token)
    return { edit, created }
  } finally {
    delete require.cache[require.resolve('../extension')]
    restore()
  }
}

test('a photo dragged from Photos is embedded and copied beside the document', async () => {
  const { edit, created } = await drop('file:///Users/student/Pictures/IMG_0001.HEIC')
  assert.equal(edit.insertText.value, '![${1:Alt text}](IMG_0001.HEIC)')
  assert.deepEqual(created, ['/Users/student/qtm285/hw-minus-1/IMG_0001.HEIC'])
  assert.deepEqual(edit.additionalEdit.edits[0].options.contents, new Uint8Array([9, 9]))
})

test('a photo already beside the document is embedded and not copied', async () => {
  const { edit, created } = await drop('file:///Users/student/qtm285/hw-minus-1/IMG_0001.HEIC')
  assert.equal(edit.insertText.value, '![${1:Alt text}](IMG_0001.HEIC)')
  assert.deepEqual(created, [])
  assert.equal(edit.additionalEdit, undefined)
})

test('a name already used beside the document does not overwrite it', async () => {
  const { edit, created } = await drop('file:///Volumes/iPhone/IMG_0001.HEIC', { siblings: ['IMG_0001.HEIC'] })
  assert.equal(edit.insertText.value, '![${1:Alt text}](IMG_0001-1.HEIC)')
  assert.deepEqual(created, ['/Users/student/qtm285/hw-minus-1/IMG_0001-1.HEIC'])
})

test('a PNG is left to Quarto, which already embeds it correctly', async () => {
  const { edit, created } = await drop('file:///Users/student/Pictures/snap.png')
  assert.equal(edit, undefined)
  assert.deepEqual(created, [])
})

test('a drag that carries no file is left alone', async () => {
  assert.equal((await drop('https://example.com/photo.heic')).edit, undefined)
  assert.equal((await drop('')).edit, undefined)
})

test('a cancelled drop writes nothing', async () => {
  const { stub, created } = makeStub()
  const restore = installVscodeStub(stub)
  try {
    delete require.cache[require.resolve('../extension')]
    const { imageDropProvider } = require('../extension')
    const edit = await imageDropProvider.provideDocumentDropEdits(
      doc, null, dataTransfer('file:///a/IMG_0001.HEIC'), { isCancellationRequested: true })
    assert.equal(edit, undefined)
    assert.deepEqual(created, [])
  } finally {
    delete require.cache[require.resolve('../extension')]
    restore()
  }
})
