// Module-resolution hooks that replace '@deepgram/sdk' with a fake whose
// connection records every upstream action to stdout, so a test can prove the
// bridge's stop/idle teardown actually fires without a live Deepgram account.
//
// Used as: node --import ./test/deepgram-fake-register.mjs bin/deepgram-sdk-bridge.mjs ...

const FAKE_SPECIFIER = '@deepgram/sdk'

const FAKE_SOURCE = `
// Fake @deepgram/sdk — emits FAKE: lines for upstream actions.
function emit(line) { try { process.stdout.write('FAKE:' + line + '\\n') } catch { /* parent stdout closed (test ended) — nothing to report */ } }

class FakeConnection {
  constructor() {
    this._handlers = {}
    this.socket = {
      readyState: 1, // WebSocket.OPEN
      send: (data) => {
        let kind = 'audio'
        if (typeof data === 'string') {
          try { kind = 'json:' + (JSON.parse(data).type || '?') } catch { kind = 'json:?' }
        } else if (process.env.FAKE_DG_RESULT_ON_AUDIO) {
          const text = process.env.FAKE_DG_RESULT_ON_AUDIO
          queueMicrotask(() => {
            this._handlers.message && this._handlers.message({
              type: 'Results',
              is_final: true,
              speech_final: true,
              channel: { alternatives: [{ transcript: text }] },
            })
          })
        }
        emit('send ' + kind)
      },
    }
  }
  on(event, cb) { this._handlers[event] = cb }
  connect() {
    emit('connect')
    // Mimic the real SDK: fire 'open' on the next tick.
    queueMicrotask(() => {
      this._handlers.open && this._handlers.open()
      // Optionally simulate Deepgram closing the session on its own (e.g. the
      // no-audio/timeout close that seeded the reconnect storm).
      const autoClose = parseInt(process.env.FAKE_DG_AUTOCLOSE_MS || '0', 10)
      if (autoClose > 0) {
        setTimeout(() => {
          if (this.socket.readyState === 1) {
            emit('autoclose')
            this.socket.readyState = 3
            this._handlers.close && this._handlers.close({ code: 1011, reason: 'NET-0001 no audio' })
          }
        }, autoClose)
      }
    })
  }
  async waitForOpen() { return true }
  close() {
    emit('close')
    this.socket.readyState = 3 // CLOSED
    queueMicrotask(() => { this._handlers.close && this._handlers.close({ code: 1000, reason: 'fake' }) })
  }
}

export class DeepgramClient {
  constructor() {
    this.listen = { v1: { connect: async (opts) => {
      emit('listen.connect endpointing=' + (opts && opts.endpointing) + ' utterance_end_ms=' + (opts && opts.utterance_end_ms))
      return new FakeConnection()
    } } }
  }
}
`

export async function resolve(specifier, context, nextResolve) {
  if (specifier === FAKE_SPECIFIER) {
    return { url: 'fake-deepgram:sdk', shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url === 'fake-deepgram:sdk') {
    return { format: 'module', source: FAKE_SOURCE, shortCircuit: true }
  }
  return nextLoad(url, context)
}
