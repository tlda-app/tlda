const path = require('node:path')
const { writeFile } = require('node:fs/promises')
const vscode = require('vscode')
const { buildSubmissionArchive } = require('./submission-package')
const { ClassroomUploadError, classroomSubmissionMetadata, submitSubmissionArchive } = require('./classroom-upload')
const { planImageDrop } = require('./image-drop')

function fileNotFound(error) {
  return error && (error.code === 'FileNotFound' || error.code === 'ENOENT')
}

async function archiveForActiveHomework() {
  const editor = vscode.window.activeTextEditor
  const document = editor?.document
  if (!document || document.uri.scheme !== 'file' || path.extname(document.uri.fsPath).toLowerCase() !== '.qmd') {
    await vscode.window.showErrorMessage('Open the homework QMD before running a Homework command.')
    return null
  }

  if (!(await document.save())) {
    await vscode.window.showErrorMessage('The QMD could not be saved, so no submission ZIP was created.')
    return null
  }

  const folder = vscode.Uri.file(path.dirname(document.uri.fsPath))
  const source = Buffer.from(await vscode.workspace.fs.readFile(document.uri)).toString('utf8')
  const archive = await buildSubmissionArchive({
    qmdName: path.basename(document.uri.fsPath),
    source,
    readAsset: async relative => {
      try {
        return await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, ...relative.split('/')))
      } catch (error) {
        if (fileNotFound(error)) {
          throw Object.assign(new Error(`Missing asset: ${relative}`), { code: 'FileNotFound' })
        }
        throw error
      }
    },
  })
  return { archive, document, folder, source }
}

async function zipForSubmission() {
  try {
    const prepared = await archiveForActiveHomework()
    if (!prepared) return
    const { archive, document, folder } = prepared

    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(folder, `${path.basename(document.uri.fsPath, path.extname(document.uri.fsPath))}.zip`),
      filters: { 'ZIP archive': ['zip'] },
      saveLabel: 'Create submission ZIP',
    })
    if (!destination) return

    await writeFile(destination.fsPath, archive.bytes)
    await vscode.window.showInformationMessage(`Created ${path.basename(destination.fsPath)} with ${archive.files.length} file${archive.files.length === 1 ? '' : 's'}.`)
  } catch (error) {
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
  }
}

function classroomTokenSecretKey(server) {
  return `tldaClassroom.studentToken:${server}`
}

async function submitHomework(context) {
  let metadata = null
  try {
    const prepared = await archiveForActiveHomework()
    if (!prepared) return
    metadata = classroomSubmissionMetadata(prepared.source)
    if (!metadata) {
      await vscode.window.showErrorMessage('This QMD does not identify its tlda classroom server and assignment. Download the assignment QMD from the class book and try again.')
      return
    }
    const secretKey = classroomTokenSecretKey(metadata.server)
    let classroomToken = await context.secrets.get(secretKey)
    if (!classroomToken) {
      classroomToken = await vscode.window.showInputBox({
        password: true,
        ignoreFocusOut: true,
        prompt: 'Paste the classroom token you received when you registered.',
        title: 'Homework: Submit',
      })
      if (!classroomToken) return
      classroomToken = classroomToken.trim()
      if (!classroomToken) return
      await context.secrets.store(secretKey, classroomToken)
    }
    const receipt = await submitSubmissionArchive({
      ...metadata,
      classroomToken,
      archiveBytes: prepared.archive.bytes,
    })
    const submitted = receipt?.submittedAt ? ` at ${new Date(receipt.submittedAt).toLocaleString()}` : ''
    await vscode.window.showInformationMessage(`Submitted ${metadata.assignmentId}${submitted}.`)
  } catch (error) {
    if (error instanceof ClassroomUploadError && error.status === 401) {
      if (metadata) await context.secrets.delete(classroomTokenSecretKey(metadata.server))
      await vscode.window.showErrorMessage('The classroom token was not accepted. Run Homework: Submit again and paste the token from registration.')
      return
    }
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
  }
}

const imageDropProvider = {
  async provideDocumentDropEdits(document, position, dataTransfer, token) {
    const list = await dataTransfer.get('text/uri-list')?.asString()
    if (!list || token.isCancellationRequested) return

    const dropped = []
    for (const line of list.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const uri = vscode.Uri.parse(line)
        if (uri.scheme === 'file') dropped.push(uri)
      } catch { /* a line that is not a URI is not a file we can copy */ }
    }

    const folder = vscode.Uri.joinPath(document.uri, '..')
    const siblings = new Set((await vscode.workspace.fs.readDirectory(folder)).map(([name]) => name))
    const plan = planImageDrop({
      docDir: path.posix.dirname(document.uri.path),
      dropped: dropped.map(uri => ({ fsPath: uri.path })),
      taken: name => siblings.has(name),
    })
    if (!plan || token.isCancellationRequested) return

    const edit = new vscode.DocumentDropEdit(new vscode.SnippetString(plan.markdown))
    edit.title = plan.copies.length ? 'Insert photo and copy it beside the document' : 'Insert photo'
    if (plan.copies.length) {
      const additional = new vscode.WorkspaceEdit()
      for (const copy of plan.copies) {
        const from = dropped.find(uri => uri.path === copy.from)
        additional.createFile(vscode.Uri.joinPath(folder, path.posix.basename(copy.to)), {
          contents: await vscode.workspace.fs.readFile(from),
          ignoreIfExists: false,
        })
      }
      edit.additionalEdit = additional
    }
    return edit
  },
}

// When two providers offer an edit, the editor applies the first. Ordering is score, then
// builtin-ness, then registration time — and the score saturates at 10, so a more specific
// selector cannot outrank Quarto's `{language:"quarto",scheme:"*"}`. Both are non-builtin, so
// the tie falls to registration time, later wins. Registering after Quarto has activated is
// therefore the whole ordering guarantee; without it, which provider handles a dropped photo
// depends on extension activation order.
async function registerImageDrop(context) {
  await vscode.extensions.getExtension('quarto.quarto')?.activate()
  context.subscriptions.push(
    vscode.languages.registerDocumentDropEditProvider({ language: 'quarto' }, imageDropProvider, {
      dropMimeTypes: ['text/uri-list'],
    }),
  )
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('tldaClassroom.zipForSubmission', zipForSubmission))
  context.subscriptions.push(vscode.commands.registerCommand('tldaClassroom.submit', () => submitHomework(context)))
  return registerImageDrop(context)
}

function deactivate() {}

module.exports = { activate, deactivate, archiveForActiveHomework, classroomTokenSecretKey, imageDropProvider, registerImageDrop, submitHomework, zipForSubmission }
