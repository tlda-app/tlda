const path = require('node:path')
const { writeFile } = require('node:fs/promises')
const vscode = require('vscode')
const { buildSubmissionArchive } = require('./submission-package')
const { ClassroomUploadError, classroomSubmissionMetadata, submitSubmissionArchive } = require('./classroom-upload')

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

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('tldaClassroom.zipForSubmission', zipForSubmission))
  context.subscriptions.push(vscode.commands.registerCommand('tldaClassroom.submit', () => submitHomework(context)))
}

function deactivate() {}

module.exports = { activate, deactivate, archiveForActiveHomework, classroomTokenSecretKey, submitHomework, zipForSubmission }
