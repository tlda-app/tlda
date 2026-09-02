import { FleetStore } from './fleet-store.mjs'

const store = new FleetStore(process.env.TLDA_FLEET_DB, { readonly: true, taskDoc: false })
const METHODS = new Set([
  'getAgentsByIds',
  'getChatContext',
  'getSearchStats',
  'resolveAgentQuery',
  'resolveAgentSelector',
  'searchAll',
])

process.on('message', async message => {
  const { id, method, args = [] } = message || {}
  if (message?.kind === 'close') {
    try {
      store.close()
      process.send?.({ kind: 'result', id, result: null })
    } catch (error) {
      process.send?.({ kind: 'result', id, error: { message: error?.message || String(error), stack: error?.stack || null } })
    }
    return
  }
  try {
    if (!METHODS.has(method)) throw new Error(`Fleet search process has no method '${method}'`)
    if (method === 'searchAll' && Number(process.env.TLDA_SEARCH_TEST_BLOCK_MS || 0) > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.TLDA_SEARCH_TEST_BLOCK_MS))
    }
    store._activeSearchContext = args.find(arg => arg?._requestContext)?._requestContext || null
    const result = await store[method](...args)
    store._activeSearchContext = null
    process.send?.({ kind: 'result', id, result })
  } catch (error) {
    store._activeSearchContext = null
    process.send?.({ kind: 'result', id, error: { message: error?.message || String(error), stack: error?.stack || null } })
  }
})

process.on('disconnect', () => {
  store.close()
  process.exit(0)
})

process.send?.({ kind: 'ready' })
