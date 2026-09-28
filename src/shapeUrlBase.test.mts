/**
 * One room, every copy: a shape url carries its author's base, so a copy on
 * a project-pages subpath must re-root same-origin urls from other bases to
 * its own — render-locally, never synced back. Cross-origin asset urls and
 * urls already under the local base pass through untouched.
 */
function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
}

const { resolveShapeUrlForServeBase } = await import('./shapeUrlBase')

const BASE = '/pages-topology-test/'
const ORIGIN = 'https://qtm285.github.io'

// The walk's 404: foreign-base copy path re-roots to the local base.
equal(
  resolveShapeUrlForServeBase('/app/book/part1-one-sample.html', BASE, ORIGIN),
  '/pages-topology-test/app/book/part1-one-sample.html',
  'foreign base re-roots',
)
equal(
  resolveShapeUrlForServeBase('/app/book/x.html?_tldaH=2&_tldaV=0#frag', BASE, ORIGIN),
  '/pages-topology-test/app/book/x.html?_tldaH=2&_tldaV=0#frag',
  'query and hash survive the re-root',
)
equal(
  resolveShapeUrlForServeBase(`${ORIGIN}/app/book/x.html`, BASE, ORIGIN),
  `${ORIGIN}/pages-topology-test/app/book/x.html`,
  'same-origin absolute keeps its absolute shape',
)

// Everything already right passes through.
equal(
  resolveShapeUrlForServeBase('/pages-topology-test/app/book/x.html?a=1', BASE, ORIGIN),
  '/pages-topology-test/app/book/x.html?a=1',
  'local base passes through',
)
equal(
  resolveShapeUrlForServeBase('app/book/x.html', BASE, ORIGIN),
  'app/book/x.html',
  'base-relative passes through',
)
equal(
  resolveShapeUrlForServeBase('https://assets.example.net/docs/paper/x.html', BASE, ORIGIN),
  'https://assets.example.net/docs/paper/x.html',
  'cross-origin passes through',
)
equal(
  resolveShapeUrlForServeBase('//assets.example.net/docs/paper/x.html', BASE, ORIGIN),
  '//assets.example.net/docs/paper/x.html',
  'protocol-relative cross-origin passes through',
)
equal(
  resolveShapeUrlForServeBase('/app/book/x.html', '/', ORIGIN),
  '/app/book/x.html',
  'root-served copy passes through',
)
equal(
  resolveShapeUrlForServeBase('/app/book/x.html', null, ORIGIN),
  '/app/book/x.html',
  'missing base is identity',
)
equal(resolveShapeUrlForServeBase('', BASE, ORIGIN), '', 'empty is identity')
equal(
  resolveShapeUrlForServeBase('http://[::1', BASE, ORIGIN),
  'http://[::1',
  'unparseable passes through',
)

console.log('shapeUrlBase: 11/11 ok')
