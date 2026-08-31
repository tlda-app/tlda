'use strict'
const vscode = require('vscode')
const path = require('path')
const fs = require('fs')

// Getting a photo into the document is where submissions break silently.
//
// Source mode has no paste handler at all: `.qmd` is language `quarto`, not
// `markdown`, so VS Code's markdown paste-image never applies. And the Quarto
// extension's drop provider inserts a path without copying the file — drag a
// photo in from Downloads and it renders perfectly in preview while being
// guaranteed absent from the zip.
//
// Both are fixed the same way: put the file next to the document first, then
// reference it by bare filename. A submission is an archive of one folder, so
// "next to the .qmd" is the only place an image can be and still travel.

const IMAGE = /\.(png|jpe?g|gif|webp|svg|heic|heif|tiff?|bmp)$/i

function uniqueName(dir, base) {
  if (!fs.existsSync(path.join(dir, base))) return base
  const ext = path.extname(base)
  const stem = path.basename(base, ext)
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`
    if (!fs.existsSync(path.join(dir, candidate))) return candidate
  }
}

/** Copy `source` beside the document and return the bare filename to reference. */
function placeBesideDocument(documentPath, sourcePath, suggestedName) {
  const dir = path.dirname(documentPath)
  const name = uniqueName(dir, suggestedName || path.basename(sourcePath))
  fs.copyFileSync(sourcePath, path.join(dir, name))
  return name
}

function placeBytesBesideDocument(documentPath, bytes, suggestedName) {
  const dir = path.dirname(documentPath)
  const name = uniqueName(dir, suggestedName)
  fs.writeFileSync(path.join(dir, name), bytes)
  return name
}

// HEIC is left alone deliberately. Converting it needs a per-platform codec —
// `sips` on macOS with no Windows equivalent — which is the one item the
// feasibility review called expensive. An iPhone photo will still insert and
// still travel with the archive; it may not display in Chrome or Firefox, and
// that is worth saying out loud rather than half-solving.
function heicWarning(name) {
  if (!/\.hei[cf]$/i.test(name)) return
  vscode.window.showWarningMessage(
    `${name} is an iPhone photo (HEIC). It will be handed in, but it may not display for everyone — export it as JPEG if you want to be sure.`,
  )
}

function markdownFor(name) {
  return `![](${name.replace(/ /g, '%20')})`
}

class QmdImagePaste {
  async provideDocumentPasteEdits(document, _ranges, dataTransfer) {
    for (const [mime, item] of dataTransfer) {
      if (!mime.startsWith('image/')) continue
      const file = item.asFile()
      if (!file) continue
      const bytes = await file.data()
      const ext = mime.split('/')[1].replace('jpeg', 'jpg')
      const name = placeBytesBesideDocument(document.uri.fsPath, Buffer.from(bytes), file.name || `pasted.${ext}`)
      heicWarning(name)
      const edit = new vscode.DocumentPasteEdit(markdownFor(name), 'Insert image beside document', vscode.DocumentDropOrPasteEditKind.Text)
      return [edit]
    }
    return undefined
  }
}

class QmdImageDrop {
  async provideDocumentDropEdits(document, _position, dataTransfer) {
    const uris = dataTransfer.get('text/uri-list')
    if (!uris) return undefined
    const inserted = []
    for (const line of (await uris.asString()).split(/\r?\n/)) {
      if (!line.trim()) continue
      let file
      try { file = vscode.Uri.parse(line.trim()).fsPath } catch { continue }
      if (!IMAGE.test(file) || !fs.existsSync(file)) continue
      const name = placeBesideDocument(document.uri.fsPath, file)
      heicWarning(name)
      inserted.push(markdownFor(name))
    }
    if (!inserted.length) return undefined
    return new vscode.DocumentDropEdit(inserted.join('\n\n'))
  }
}

function register(context) {
  const quarto = { language: 'quarto' }
  context.subscriptions.push(
    vscode.languages.registerDocumentPasteEditProvider(quarto, new QmdImagePaste(), {
      providedPasteEditKinds: [vscode.DocumentDropOrPasteEditKind.Text],
      pasteMimeTypes: ['image/*'],
    }),
    vscode.languages.registerDocumentDropEditProvider(quarto, new QmdImageDrop()),
  )
}

module.exports = { register, placeBesideDocument, placeBytesBesideDocument, uniqueName, markdownFor, IMAGE }
