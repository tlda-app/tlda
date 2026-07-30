import { EventEmitter } from 'node:events'

export function createTransportFixture() {
  const sockets = []
  class FixtureSocket extends EventEmitter {
    static OPEN = 1
    constructor() {
      super()
      this.readyState = FixtureSocket.OPEN
      this.sent = []
      sockets.push(this)
      queueMicrotask(() => this.emit('open'))
    }
    send(raw) {
      const message = JSON.parse(raw)
      this.sent.push(message)
      if (message.type === 'reserve-shell') {
        queueMicrotask(() => this.emit('message', JSON.stringify({ id: message.id, result: { ok: true } })))
      }
    }
    reply(request, result) {
      this.emit('message', JSON.stringify({ id: request.id, result }))
    }
    event(message) {
      this.emit('message', JSON.stringify(message))
    }
    close() {
      if (this.readyState === 3) return
      this.readyState = 3
      this.emit('close')
    }
  }
  return { WebSocketClass: FixtureSocket, sockets }
}
