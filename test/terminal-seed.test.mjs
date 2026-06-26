import test from 'node:test'
import assert from 'node:assert/strict'
import {
  terminalBackscrollCaptureArgs,
  terminalVisibleCaptureArgs,
  trimTerminalSeedBlankRows,
} from '../shared/terminal-seed.mjs'

test('trimTerminalSeedBlankRows keeps the last meaningful error line visible', () => {
  const input = [
    'Loading recipe: Fleet DeepSeek agent',
    'Please check your account with your provider to add more credits, then resend your message to continue.',
    '',
    '',
    '',
  ].join('\n')

  assert.equal(trimTerminalSeedBlankRows(input), [
    'Loading recipe: Fleet DeepSeek agent',
    'Please check your account with your provider to add more credits, then resend your message to continue.',
    '',
  ].join('\n'))
})

test('trimTerminalSeedBlankRows treats ansi-only trailing rows as blank', () => {
  const input = 'useful output\n\x1b[0m   \n\x1b[2m\x1b[0m\n'

  assert.equal(trimTerminalSeedBlankRows(input), 'useful output\n')
})

test('terminal visible capture uses only the current pane', () => {
  assert.deepEqual(
    terminalVisibleCaptureArgs('fleet-agent', { ansi: true }),
    ['capture-pane', '-t', 'fleet-agent', '-p', '-e'],
  )
})

test('terminal backscroll capture opts into scrollback explicitly', () => {
  assert.deepEqual(
    terminalBackscrollCaptureArgs('fleet-agent', 500, { ansi: true }),
    ['capture-pane', '-t', 'fleet-agent', '-p', '-e', '-S', '-500'],
  )
})
