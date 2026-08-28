const path = require('node:path')

// Quarto's own drop provider decides between `![alt](x)` and `[label](x)` from this set:
//   new Set(["bmp","gif","ico","jpe","jpeg","jpg","png","psd","svg","tga","tif","tiff","webp"])
// (~/.positron/extensions/quarto.quarto-*/out/main.js). A camera photo is none of them, so a
// dragged iPhone photo becomes a LINK, which `submission-package.js` correctly does not treat
// as an asset — the photo is then absent from the ZIP with no error anywhere. We own exactly
// the image formats missing from that set, and leave the ones Quarto already gets right alone.
const HANDLED = new Set(['heic', 'heif', 'avif'])

function extensionOf(name) {
  return path.posix.extname(name).toLowerCase().replace('.', '')
}

function handlesImage(name) {
  return HANDLED.has(extensionOf(name))
}

// `photo.heic` -> `photo-1.heic` -> `photo-2.heic`, so a second drop never overwrites the first.
function availableName(name, taken) {
  if (!taken(name)) return name
  const extension = path.posix.extname(name)
  const stem = path.posix.basename(name, extension)
  for (let n = 1; ; n += 1) {
    const candidate = `${stem}-${n}${extension}`
    if (!taken(candidate)) return candidate
  }
}

/**
 * Plan the edit for images dropped into a Quarto document.
 *
 * Pure so it can be tested without vscode: the caller turns `markdown` into a SnippetString and
 * `copies` into WorkspaceEdit.createFile calls, which is what makes the copy undoable.
 *
 * @param docDir  posix directory holding the .qmd
 * @param dropped [{ fsPath }] dropped files, in drop order
 * @param taken   (name) => boolean — is this name already used beside the document
 * @returns null when nothing dropped is ours, else { markdown, copies: [{ from, to }] }
 */
function planImageDrop({ docDir, dropped, taken = () => false }) {
  const ours = dropped.filter(file => handlesImage(file.fsPath))
  if (!ours.length) return null

  const claimed = new Set()
  const copies = []
  const parts = []

  ours.forEach((file, index) => {
    const from = file.fsPath
    const inPlace = path.posix.dirname(from) === docDir
    // Dropping from Photos or Downloads leaves the file outside the assignment folder, where
    // `safeRelativeAsset` refuses it. Copying it next to the document is what makes it travel.
    const name = inPlace
      ? path.posix.basename(from)
      : availableName(path.posix.basename(from), candidate => claimed.has(candidate) || taken(candidate))
    claimed.add(name)
    if (!inPlace) copies.push({ from, to: `${docDir}/${name}` })
    parts.push(`![\${${index + 1}:Alt text}](${encodeURI(name)})`)
  })

  return { markdown: parts.join(' '), copies }
}

module.exports = { HANDLED, availableName, extensionOf, handlesImage, planImageDrop }
