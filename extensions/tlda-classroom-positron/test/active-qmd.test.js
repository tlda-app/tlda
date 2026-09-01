'use strict'
const assert = require('node:assert/strict')
const Module = require('node:module')
const test = require('node:test')

test('uses the active custom-editor tab when Visual Mode has no text editor', async () => {
  const uri = { fsPath: '/tmp/homework.qmd' }
  let saved = false
  const document = {
    fileName: uri.fsPath,
    isDirty: true,
    async save() { saved = true; return true },
  }
  const vscode = {
    window: {
      activeTextEditor: undefined,
      tabGroups: { activeTabGroup: { activeTab: { input: { uri } } } },
      showErrorMessage() { assert.fail('the open QMD must not be rejected') },
    },
    workspace: {
      async openTextDocument(opened) {
        assert.equal(opened, uri)
        return document
      },
    },
  }
  const originalLoad = Module._load
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return vscode
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    delete require.cache[require.resolve('../src/extension')]
    const { activeQmd } = require('../src/extension')
    assert.equal(await activeQmd(), uri.fsPath)
    assert.equal(saved, true)
  } finally {
    Module._load = originalLoad
    delete require.cache[require.resolve('../src/extension')]
  }
})
