export function attachIndexChatTail(log, rows, ResizeObserverImpl = globalThis.ResizeObserver) {
  const followTail = () => { log.scrollTop = log.scrollHeight }
  followTail()
  const observer = new ResizeObserverImpl(followTail)
  observer.observe(rows)
  return () => observer.disconnect()
}
