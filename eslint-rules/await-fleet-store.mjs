// ESLint rule: a FleetStore call that returns a Promise must be consumed as one.
//
// See server/lib/fleet-store-async-methods.mjs for the list this enforces and
// the reason it is a list. In short: a missed `await` yields a Promise, a
// Promise is truthy, and every property on it is `undefined` — so `agent.dead`
// on an un-awaited `getAgent` reads as ALIVE. It does not throw. It produces
// wrong fleet state silently.
//
// A call is accepted when its value actually goes somewhere that handles a
// Promise: `await`, `return`, an arrow body, `.then`/`.catch`/`.finally`,
// `yield`, or an element of `Promise.all`/`allSettled`/`race`/`any`. Deliberate
// fire-and-forget is spelled `void store.x(…)` — which is the point of allowing
// it: `void` makes "I know this is a promise and I am dropping it" legible in a
// diff, where a bare statement is indistinguishable from a forgotten `await`.
//
// Assigning without awaiting (`const a = store.getAgent(id)`) is REJECTED even
// though `const p = store.share(e); await p` is a legal shape, because the
// rejected form is the exact catastrophic case above and the legal form is rare
// enough to write as `await` directly.

import { FLEET_STORE_ASYNC_METHODS } from '../server/lib/fleet-store-async-methods.mjs'

const ASYNC_METHODS = new Set(FLEET_STORE_ASYNC_METHODS)
const PROMISE_COMBINATORS = new Set(['all', 'allSettled', 'race', 'any'])
const PROMISE_HANDLERS = new Set(['then', 'catch', 'finally'])

// Default receivers. `fleetStore` covers the server's module-level handle and
// every `x.fleetStore` / `app.locals.fleetStore` form, since only the final
// property name is compared.
const DEFAULT_RECEIVERS = ['fleetStore', 'store']

// WHICH `store` THIS RULE IS ABOUT.
//
// `FleetStore` is the class and it is synchronous — `upsertAgent`, `getAgent`
// and the rest are declared without `async`. The Promises come from
// `FleetStoreClient`, the worker-thread proxy, which is what the server holds
// (`const fleetStore = new FleetStoreClient(...)`, `app.locals.fleetStore`).
//
// So a receiver holding a directly-constructed `FleetStore` has nothing to
// await, and every call on it was being reported. Tests construct it on purpose
// — they need the direct handle to read `store.db.prepare(...)` synchronously —
// and `store` is the obvious name for it. That was 103 reports across ten files,
// all of them wrong, against a rule whose whole value is that a report means
// something.
//
// `store` cannot simply be dropped from the receiver list: it is also the name
// `server/lib/task-doc-worker-boundary.test.mjs` gives a real `FleetStoreClient`.
// The distinction is what the receiver was built from, not what it is called.
const SYNCHRONOUS_CONSTRUCTORS = new Set(['FleetStore'])
const ASYNC_CONSTRUCTORS = new Set(['FleetStoreClient'])

/**
 * What `name` was built from, as far as this file can show: 'sync' for
 * `new FleetStore(...)`, 'async' for `new FleetStoreClient(...)`, 'other' for
 * anything else we can see it being assigned, or null when it does not resolve
 * here (a module handle, `this.store`, a callback parameter).
 */
function receiverOrigin(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name)
    if (!variable) continue
    for (const def of variable.defs) {
      if (def.type !== 'Variable' || def.node.type !== 'VariableDeclarator') continue
      const init = def.node.init
      if (!init) continue
      const constructed = init.type === 'NewExpression' && init.callee?.type === 'Identifier'
        ? init.callee.name
        : null
      if (constructed && SYNCHRONOUS_CONSTRUCTORS.has(constructed)) return 'sync'
      if (constructed && ASYNC_CONSTRUCTORS.has(constructed)) return 'async'
      return 'other'
    }
    return null
  }
  return null
}

/** The name the callee is reached through: `a.b.fleetStore.share()` -> "fleetStore". */
function receiverName(callee) {
  const object = callee.object
  if (!object) return null
  if (object.type === 'Identifier') return object.name
  if (object.type === 'ThisExpression') return 'this'
  if (object.type === 'MemberExpression' && !object.computed && object.property) return object.property.name
  if (object.type === 'ChainExpression') return receiverName({ object: object.expression })
  return null
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Require FleetStore promise-returning calls to be awaited' },
    schema: [{
      type: 'object',
      properties: { receivers: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    }],
    messages: {
      floating:
        "`{{receiver}}.{{method}}()` returns a Promise — await it. Un-awaited, it is a truthy " +
        'object whose every property is undefined, so a check like `.dead` reads as false and ' +
        'the fleet gets wrong state without an error. If dropping it is deliberate, write ' +
        '`void {{receiver}}.{{method}}(…)`.',
    },
  },

  create(context) {
    const receivers = new Set(context.options?.[0]?.receivers || DEFAULT_RECEIVERS)

    // Scope resolution cannot follow a receiver that arrives as a callback
    // parameter, which is the shape most of these tests use:
    //
    //     function withStore(run) { const store = new FleetStore(…); return run(store) }
    //     test('…', () => withStore(store => store.upsertAgent(…)))
    //
    // So fall back to the file: a module that builds the synchronous class and
    // never builds the client has no proxy in it to await. A module that builds
    // both — `server/lib/fleet-store-offloop.test.mjs` does — gets no such
    // exemption and is checked by scope resolution alone. Candidates are held
    // until `Program:exit` so the decision reads the whole file, not the part
    // traversed so far.
    const constructions = new Set()
    const candidates = []

    // Walk out through parentheses and optional-chaining wrappers, which sit
    // between the call and whatever actually consumes it.
    function consumer(node) {
      let child = node
      let parent = child.parent
      while (parent && (parent.type === 'ChainExpression' || parent.type === 'TSNonNullExpression')) {
        child = parent
        parent = parent.parent
      }
      return { parent, child }
    }

    function isConsumed(node) {
      const { parent, child } = consumer(node)
      if (!parent) return false

      switch (parent.type) {
        case 'AwaitExpression':
        case 'ReturnStatement':
        case 'YieldExpression':
          return true
        case 'UnaryExpression':
          return parent.operator === 'void'
        case 'ArrowFunctionExpression':
          // Implicit return: `() => store.share(e)` hands the promise to the caller.
          return parent.body === child
        case 'MemberExpression':
          return parent.object === child && !parent.computed
            && PROMISE_HANDLERS.has(parent.property?.name)
        case 'ArrayExpression': {
          // `Promise.all([ store.share(a), store.share(b) ])`
          const outer = parent.parent
          return !!outer && outer.type === 'CallExpression'
            && outer.callee.type === 'MemberExpression'
            && outer.callee.object?.name === 'Promise'
            && PROMISE_COMBINATORS.has(outer.callee.property?.name)
        }
        case 'CallExpression':
          // Handed to `Promise.resolve(…)` / `Promise.reject(…)`, which is a real
          // way this codebase adapts a maybe-promise before `.then`ing it. Only
          // `Promise.*` counts: passing the promise to any other function —
          // `console.log(store.share(e))` — is the bug, not a consumer.
          return parent.callee?.type === 'MemberExpression'
            && parent.callee.object?.name === 'Promise'
            && parent.arguments.includes(child)
        default:
          return false
      }
    }

    return {
      NewExpression(node) {
        if (node.callee?.type === 'Identifier') constructions.add(node.callee.name)
      },

      CallExpression(node) {
        const callee = node.callee
        if (!callee || callee.type !== 'MemberExpression' || callee.computed) return
        const method = callee.property?.name
        if (!method || !ASYNC_METHODS.has(method)) return
        const receiver = receiverName(callee)
        if (!receiver || !receivers.has(receiver)) return
        if (isConsumed(node)) return

        const origin = callee.object.type === 'Identifier'
          ? receiverOrigin(context.sourceCode.getScope(node), receiver)
          : null
        // Built here, and not from the client: nothing to await.
        if (origin === 'sync' || origin === 'other') return
        candidates.push({ node, receiver, method, origin })
      },

      'Program:exit'() {
        const syncOnlyModule = [...SYNCHRONOUS_CONSTRUCTORS].some(name => constructions.has(name))
          && ![...ASYNC_CONSTRUCTORS].some(name => constructions.has(name))
        for (const { node, receiver, method, origin } of candidates) {
          if (origin === null && syncOnlyModule) continue
          context.report({ node, messageId: 'floating', data: { receiver, method } })
        }
      },
    }
  },
}
