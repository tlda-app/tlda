const dns = require('node:dns')

function loadAliases() {
  const host = process.env.TLDA_NODE_DNS_ALIAS_HOST
  const address = process.env.TLDA_NODE_DNS_ALIAS_ADDR
  if (host && address) return new Map([[host.toLowerCase(), address]])

  const raw = process.env.TLDA_NODE_DNS_ALIASES
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const aliases = new Map()
    for (const [host, value] of Object.entries(parsed)) {
      if (!host || typeof value !== 'string' || !value) continue
      aliases.set(host.toLowerCase(), value)
    }
    return aliases.size ? aliases : null
  } catch {
    return null
  }
}

const aliases = loadAliases()

if (aliases) {
  const realLookup = dns.lookup
  const realPromisesLookup = dns.promises?.lookup?.bind(dns.promises)

  function familyFor(address) {
    return address.includes(':') ? 6 : 4
  }

  dns.lookup = function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    options = options || {}
    const address = aliases.get(String(hostname).toLowerCase())
    if (!address) return realLookup.call(dns, hostname, options, callback)
    const family = familyFor(address)
    process.nextTick(() => {
      if (options.all) callback(null, [{ address, family }])
      else callback(null, address, family)
    })
  }

  if (realPromisesLookup) {
    dns.promises.lookup = async function lookup(hostname, options = {}) {
      const address = aliases.get(String(hostname).toLowerCase())
      if (!address) return realPromisesLookup(hostname, options)
      const family = familyFor(address)
      if (options?.all) return [{ address, family }]
      return { address, family }
    }
  }
}
