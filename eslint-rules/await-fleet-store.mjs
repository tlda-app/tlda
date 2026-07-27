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
      CallExpression(node) {
        const callee = node.callee
        if (!callee || callee.type !== 'MemberExpression' || callee.computed) return
        const method = callee.property?.name
        if (!method || !ASYNC_METHODS.has(method)) return
        const receiver = receiverName(callee)
        if (!receiver || !receivers.has(receiver)) return
        if (isConsumed(node)) return
        context.report({ node, messageId: 'floating', data: { receiver, method } })
      },
    }
  },
}
