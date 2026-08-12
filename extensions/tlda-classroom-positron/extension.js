const path = require('node:path')
const vscode = require('vscode')
const { buildSubmissionArchive } = require('./submission-package')

function fileNotFound(error) {
  return error && (error.code === 'FileNotFound' || error.code === 'ENOENT')
}

async function zipForSubmission() {
  const editor = vscode.window.activeTextEditor
  const document = editor?.document
  if (!document || document.uri.scheme !== 'file' || path.extname(document.uri.fsPath).toLowerCase() !== '.qmd') {
    await vscode.window.showErrorMessage('Open the homework QMD before running Homework: Zip for submission.')
    return
  }

  if (!(await document.save())) {
    await vscode.window.showErrorMessage('The QMD could not be saved, so no submission ZIP was created.')
    return
  }

  try {
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

    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(folder, `${path.basename(document.uri.fsPath, path.extname(document.uri.fsPath))}.zip`),
      filters: { 'ZIP archive': ['zip'] },
      saveLabel: 'Create submission ZIP',
    })
    if (!destination) return

    await vscode.workspace.fs.writeFile(destination, archive.bytes)
    await vscode.window.showInformationMessage(`Created ${path.basename(destination.fsPath)} with ${archive.files.length} file${archive.files.length === 1 ? '' : 's'}.`)
  } catch (error) {
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
  }
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('tldaClassroom.zipForSubmission', zipForSubmission))
}

function deactivate() {}

module.exports = { activate, deactivate, zipForSubmission }
