import assert from 'node:assert/strict'
import test from 'node:test'

import { editorOwningFleetShape } from '../src/shapes/fleet-pill-drop-target.ts'

test('fleet pill filter commits stay in the HUD editor when it owns the chat', () => {
  const hudEditor = { getShape: (id) => id === 'shape:chat' ? { id } : undefined }
  const mainEditor = { getShape: () => undefined }

  assert.equal(editorOwningFleetShape(hudEditor, mainEditor, 'shape:chat'), hudEditor)
})

test('fleet pill filter commits fall back to the main editor for main-owned chats', () => {
  const hudEditor = { getShape: () => undefined }
  const mainEditor = { getShape: (id) => id === 'shape:chat' ? { id } : undefined }

  assert.equal(editorOwningFleetShape(hudEditor, mainEditor, 'shape:chat'), mainEditor)
})
