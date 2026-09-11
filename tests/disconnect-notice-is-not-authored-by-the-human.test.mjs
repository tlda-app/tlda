import assert from 'node:assert/strict'
import test from 'node:test'
import { createTerminalRpc } from '../daemon/terminal-rpc.mjs'
import { isMachineAuthoredText } from '../agent-runtime/terminal-chat-authorship.mjs'

const BARE = 'The tlda connection seems disconnected. Consider running: tlda-dev restart-mcp fleet:test'

function emitterPasteText() {
  const calls = []
  const rpc = createTerminalRpc({
    tmuxArgs: [], log: { info() {}, warn() {}, error() {} }, sendMsg() {},
    detectPrompt: () => ({ type: 'none' }), stripAnsi: value => value,
    promptCooldowns: new Map(), surfacedPrompts: new Map(), alivenessCache: new Map(),
    thinkingSpinnerRe: /NEVER_MATCH/, interruptHintRe: /NEVER_MATCH/,
    thinkingScanLines: 5, terminalSizePollMs: 1000,
    decideTerminalWatchExit: () => ({ terminalDead: false }),
    onArmAgent() {}, onArmBySession() {}, onSessionInventoryChanged() {},
    onPlanModeSeen() {}, onPlanModeGone() {}, hasPlanMode: () => false,
    resolveAgentRoute: () => ({ tmux_session: 'agent-session', agent_id: 'fleet:test' }),
    validateTmuxOwner: () => true,
    resolveTerminalAgent: () => ({ id: 'fleet:test', tmuxSession: 'agent-session', sessionId: 'session-1' }),
    terminalInputAllowed: false,
    execFileImpl: async (cmd, args) => {
      calls.push([cmd, args])
      return { stdout: args.includes('capture-pane') ? 'ready\n❯ ' : '', stderr: '' }
    },
  })
  return { rpc, calls }
}

test('the unmarked notice is classified as human-authored — the regression control', () => {
  assert.equal(isMachineAuthoredText(BARE), false)
})

test('the emitted disconnect notice carries the app marker and is not human-authored', async () => {
  const { rpc, calls } = emitterPasteText()
  assert.equal((await rpc.notifyConnectionDisconnected({ agent_id: 'fleet:test' })).ok, true)
  const pasted = calls.find(([, args]) => args[0] === 'set-buffer')[1].at(-1)
  assert.equal(pasted, `💻 ${BARE}`)
  assert.equal(isMachineAuthoredText(pasted), true)
})

test('terminal control bytes do not change the marked notice authorship', () => {
  assert.equal(isMachineAuthoredText(`\u0015💻 ${BARE}`), true)
  assert.equal(isMachineAuthoredText(`\r💻 ${BARE}`), true)
})
