'use strict'
const vscode = require('vscode')
const path = require('path')
const fs = require('fs')
const { zipSync } = require('fflate')
const { problems } = require('./submission')
const images = require('./images')
const visualModeCss = require('./visual-mode-css')
const { ClassroomUploadError, classroomSubmissionMetadata, submitSubmissionArchive } = require('./classroom-upload')
const { classroomTokenFromUri } = require('./classroom-token')

// Positron has no zip command of its own — the only one in the whole app is a
// Copilot chat-log export. So "zip the folder" is Finder or Explorer, which is
// where submissions actually break: folder-select prefixes every entry, macOS
// adds __MACOSX AppleDouble files that a naive "find the .qmd" matches as a
// second candidate, and a previewed document ships its whole _files directory.
//
// Building the archive here instead of describing how to build it removes all
// of that at once, because we choose what goes in.

// Saving first is not a convenience. Both commands read the document back off
// disk, so an unsaved edit is silently absent from what the student hands in —
// they see their answer on screen and submit the version without it.
async function activeQmd() {
  const editor = vscode.window.activeTextEditor
  const file = editor && editor.document.fileName
  if (!file || !file.toLowerCase().endsWith('.qmd')) {
    vscode.window.showErrorMessage('Open your homework .qmd first, then run this.')
    return null
  }
  if (editor.document.isDirty && !(await editor.document.save())) {
    vscode.window.showErrorMessage('Your .qmd could not be saved, so nothing was handed in.')
    return null
  }
  return file
}


async function checkSubmission() {
  const file = await activeQmd()
  if (!file) return
  const dir = path.dirname(file)
  const source = fs.readFileSync(file, 'utf8')
  const found = problems(source, image => fs.existsSync(path.join(dir, image)))
  if (!found.length) {
    vscode.window.showInformationMessage('This looks ready to hand in.')
    return
  }
  // One at a time, in a modal: a student who is about to submit should have to
  // read the thing that is wrong, not glance at a status bar.
  vscode.window.showWarningMessage(
    `${found.length} thing${found.length === 1 ? '' : 's'} to fix before handing in:`,
    { modal: true, detail: found.join('\n\n') },
  )
}

/**
 * Everything in the assignment folder, which is what the student was handed.
 *
 * This used to assemble the archive from the document's own references — the
 * .qmd plus its markdown images. That is a guess at a dependency closure, and
 * it was wrong twice over for a real handout: it missed `shared-code.qmd`,
 * pulled in by a Quarto include shortcode, and the `<stem>.qmd.support/`
 * directory that the handout's front matter names for its filter and baseline.
 * The upload refused the result, so the first assignment of the semester could
 * not be handed in by anyone who followed the instructions.
 *
 * The handout arrives as a folder and is meant to travel as one. Sending what
 * they actually have needs no closure analysis and cannot fall behind a change
 * to how handouts are built.
 *
 * Skipped: our own previous output, and the OS junk the server discards anyway.
 */
function collectFolder(root) {
  const files = {}
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name
      if (name === '.DS_Store' || name === '__MACOSX' || name === 'Thumbs.db') continue
      if (/-submission\.zip$/i.test(name)) continue
      const full = path.join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (entry.isDirectory()) walk(full, rel)
      else files[rel] = new Uint8Array(fs.readFileSync(full))
    }
  }
  walk(root, '')
  return files
}

/**
 * The archive both commands hand over, with the student given a chance to stop.
 *
 * `anyway` is the label on the button that proceeds past the checks. It says
 * what will happen next, because the two commands do different things with the
 * result and "OK" would not tell the student which.
 */
async function prepareArchive(anyway) {
  const file = await activeQmd()
  if (!file) return null
  const dir = path.dirname(file)
  const base = path.basename(file).replace(/\.qmd$/i, '')
  const source = fs.readFileSync(file, 'utf8')

  const found = problems(source, image => fs.existsSync(path.join(dir, image)))
  if (found.length) {
    const go = await vscode.window.showWarningMessage(
      `${found.length} thing${found.length === 1 ? '' : 's'} would stop this being marked.`,
      { modal: true, detail: found.join('\n\n') },
      anyway,
    )
    if (go !== anyway) return null
  }

  const files = collectFolder(dir)
  return { dir, base, source, files, bytes: Buffer.from(zipSync(files)) }
}

async function zipForSubmission() {
  const prepared = await prepareArchive('Zip anyway')
  if (!prepared) return
  const { dir, base, files, bytes } = prepared

  const target = path.join(dir, `${base}-submission.zip`)
  fs.writeFileSync(target, bytes)
  const choice = await vscode.window.showInformationMessage(
    `Made ${base}-submission.zip — ${Object.keys(files).length} files. Upload this.`,
    'Show it',
  )
  if (choice === 'Show it') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target))
}

function classroomTokenSecretKey(server) {
  return `tldaClassroom.studentToken:${server}`
}

async function receiveClassroomToken(context, uri) {
  if (uri.path !== '/classroom-token') return
  const registration = classroomTokenFromUri(uri)
  if (!registration) {
    await vscode.window.showErrorMessage('That classroom registration link is not valid.')
    return
  }
  await context.secrets.store(classroomTokenSecretKey(registration.server), registration.classroomToken)
  await vscode.window.showInformationMessage('Positron is connected to the class. You can hand in homework from here.')
}

// Hand in without leaving the editor. The ZIP command stays: it is the way to
// hand in when the network is the thing that is broken, and it is what a
// student who has already been told "upload this" is looking for.
async function submitHomework(context) {
  let metadata = null
  try {
    const prepared = await prepareArchive('Submit anyway')
    if (!prepared) return

    metadata = classroomSubmissionMetadata(prepared.source)
    if (!metadata) {
      await vscode.window.showErrorMessage('This .qmd does not say which classroom server and assignment it belongs to. Download the assignment again from the class book, and use "Zip for submission" if you need to hand in now.')
      return
    }

    const secretKey = classroomTokenSecretKey(metadata.server)
    let classroomToken = await context.secrets.get(secretKey)
    if (!classroomToken) {
      classroomToken = (await vscode.window.showInputBox({
        password: true,
        ignoreFocusOut: true,
        title: 'Homework: Submit',
        prompt: 'Paste the classroom token you received when you registered.',
      }) || '').trim()
      if (!classroomToken) return
      await context.secrets.store(secretKey, classroomToken)
    }

    const receipt = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Submitting ${metadata.assignmentId}…` },
      () => submitSubmissionArchive({ ...metadata, classroomToken, archiveBytes: prepared.bytes }),
    )
    const at = receipt && receipt.submittedAt ? ` at ${new Date(receipt.submittedAt).toLocaleString()}` : ''
    await vscode.window.showInformationMessage(`Handed in ${metadata.assignmentId}${at} — ${Object.keys(prepared.files).length} files.`)
  } catch (error) {
    // A token that the server refuses is a token worth forgetting, or the
    // student is stuck retrying with the bad one and has no way to clear it.
    if (error instanceof ClassroomUploadError && error.status === 401) {
      if (metadata) await context.secrets.delete(classroomTokenSecretKey(metadata.server))
      await vscode.window.showErrorMessage('That classroom token was not accepted. Run Homework: Submit again and paste the token from registration.')
      return
    }
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
  }
}

function activate(context) {
  try {
    visualModeCss.install(vscode.extensions.getExtension('quarto.quarto')?.extensionPath)
  } catch (error) {
    vscode.window.showWarningMessage(`tlda Classroom could not style homework callouts in visual mode: ${error.message}`)
  }
  // Photos land beside the document, so they travel with the archive.
  images.register(context)
  context.subscriptions.push(
    vscode.window.registerUriHandler({ handleUri: uri => receiveClassroomToken(context, uri) }),
    vscode.commands.registerCommand('tldaClassroom.checkSubmission', checkSubmission),
    vscode.commands.registerCommand('tldaClassroom.zipForSubmission', zipForSubmission),
    vscode.commands.registerCommand('tldaClassroom.submit', () => submitHomework(context)),
  )
}

module.exports = { activate, deactivate() {}, classroomTokenSecretKey, collectFolder, receiveClassroomToken }
