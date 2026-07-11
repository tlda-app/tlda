export class WsReconnectBuffer {
  constructor({ isConnected }) {
    if (typeof isConnected !== 'function') throw new Error('WsReconnectBuffer requires isConnected')
    this.isConnected = isConnected
    this.waiters = new Set()
  }

  resolveConnected() {
    for (const waiter of this.waiters) waiter.resolve()
    this.waiters.clear()
  }

  waitForConnection(timeoutMs) {
    if (this.isConnected()) return Promise.resolve(true)
    return new Promise(resolve => {
      const waiter = {
        resolve: () => {
          if (waiter.timer) clearTimeout(waiter.timer)
          resolve(true)
        },
        timer: null,
      }
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve(false)
      }, Math.max(0, timeoutMs))
      this.waiters.add(waiter)
    })
  }
}
