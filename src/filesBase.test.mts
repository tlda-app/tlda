/**
 * filesBasePath: the served base a published copy resolves files against.
 *
 * Domain-root serving (file server, user site) resolves at `/`, unchanged.
 * Project-pages subpath serving resolves under the project path. The build
 * bakes the base into BASE_URL; this helper only normalizes it, and the
 * wiring line below it is the one consumer.
 */

function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
}

// pageSource reads the server-injected config at module-eval, so stub the
// window global first and import dynamically — the same stub shape the
// recording tests use.
;(globalThis as Record<string, unknown>).window = {
  __TLDA_CONFIG__: {
    name: 'files-base-test',
    database: { http: 'https://db.invalid', ws: 'wss://db.invalid' },
    store: { http: 'https://store.invalid', ws: 'wss://store.invalid' },
    licenseKey: '',
    pages: 'files',
  },
}

const { filesBasePath, joinServedBase, documentBase } = await import('./pageSource')

// Domain root: missing or root base resolves at '/'.
equal(filesBasePath(undefined), '/', 'undefined base')
equal(filesBasePath(''), '/', 'empty base')
equal(filesBasePath('/'), '/', 'root base')

// Project subpath: the project path survives, trailing slash normalized.
equal(filesBasePath('/pages-topology-test/'), '/pages-topology-test/', 'subpath base')
equal(filesBasePath('/pages-topology-test'), '/pages-topology-test/', 'subpath base without slash')

// Joining never doubles: a path already carrying the base passes through.
equal(joinServedBase('/', '/'), '/', 'root join root')
equal(joinServedBase('/', '/docs/x/'), '/docs/x/', 'root join deep path')
equal(joinServedBase('/pages-topology-test/', '/pages-topology-test/'), '/pages-topology-test/', 'subpath passthrough')
equal(joinServedBase('/pages-topology-test/', '/other/'), '/pages-topology-test/other/', 'subpath join rooted path')
equal(joinServedBase(undefined, '/docs/x/'), '/docs/x/', 'missing base joins at root')

// Wiring: under node/tsx import.meta.env has no BASE_URL, so documentBase
// resolves the domain-root default — the pre-change behavior, pinned.
equal(documentBase('qtm285-book'), '/', 'documentBase defaults to root')

console.log('filesBase: 11/11 ok')
