import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isPhoneFleetDefaultViewport,
  selectAutoFleetDefaultLayout,
} from '../src/pills/fleet-phone-default.ts'

test('phone default viewport does not classify short wide fine-pointer desktop windows as phone', () => {
  assert.equal(isPhoneFleetDefaultViewport({
    width: 1400,
    height: 580,
    pointerCoarse: false,
    maxTouchPoints: 0,
  }), false)
})

test('phone default viewport does not classify fine-pointer narrow portrait desktop windows as phone', () => {
  assert.equal(isPhoneFleetDefaultViewport({
    width: 390,
    height: 844,
    pointerCoarse: false,
    maxTouchPoints: 0,
  }), false)
})

test('phone default viewport classifies narrow portrait phone windows', () => {
  assert.equal(isPhoneFleetDefaultViewport({
    width: 390,
    height: 844,
    pointerCoarse: true,
    maxTouchPoints: 5,
  }), true)
})

test('phone default viewport classifies landscape phone windows without relying on rotation', () => {
  assert.equal(isPhoneFleetDefaultViewport({
    width: 844,
    height: 390,
    pointerCoarse: true,
    maxTouchPoints: 5,
  }), true)
})

test('phone default viewport keeps iPad split-view narrow panes out of phone default', () => {
  assert.equal(isPhoneFleetDefaultViewport({
    width: 500,
    height: 1024,
    pointerCoarse: true,
    maxTouchPoints: 5,
  }), false)
})

test('phone vacuum may seed single-chat only when no owned fleet shapes exist', () => {
  assert.equal(selectAutoFleetDefaultLayout({
    explicitLayout: false,
    automatedSession: false,
    phoneViewport: true,
    ownedFleetShapeCount: 0,
  }), 'single-chat')
  assert.equal(selectAutoFleetDefaultLayout({
    explicitLayout: false,
    automatedSession: false,
    phoneViewport: true,
    ownedFleetShapeCount: 1,
  }), null)
})

test('automated vacuum seeds 3-col through the store-aware default path', () => {
  assert.equal(selectAutoFleetDefaultLayout({
    explicitLayout: false,
    automatedSession: true,
    phoneViewport: false,
    ownedFleetShapeCount: 0,
  }), '3-col')
  assert.equal(selectAutoFleetDefaultLayout({
    explicitLayout: false,
    automatedSession: true,
    phoneViewport: true,
    ownedFleetShapeCount: 0,
  }), '3-col')
  assert.equal(selectAutoFleetDefaultLayout({
    explicitLayout: false,
    automatedSession: true,
    phoneViewport: false,
    ownedFleetShapeCount: 1,
  }), null)
})

test('explicit fleetLayout selection always blocks automatic phone default', () => {
  assert.equal(selectAutoFleetDefaultLayout({
    explicitLayout: true,
    automatedSession: false,
    phoneViewport: true,
    ownedFleetShapeCount: 0,
  }), null)
  assert.equal(selectAutoFleetDefaultLayout({
    explicitLayout: true,
    automatedSession: true,
    phoneViewport: false,
    ownedFleetShapeCount: 0,
  }), null)
})
