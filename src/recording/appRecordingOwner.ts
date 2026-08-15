export function createAppRecordingOwner(open: (doc: string) => () => void) {
  let close: (() => void) | null = null
  return {
    observe(doc: string | null, enabled: boolean) {
      if (!enabled || !doc || close) return
      close = open(doc)
    },
    exit() {
      close?.()
      close = null
    },
  }
}
