/**
 * formatFleetAgentModel: the recorded model string is frozen at mint, so a
 * rename leaves old rows holding the retired alias. The panel resolves the
 * recorded string through the alias history before matching the live catalog,
 * so old and new rows show one name with no migration.
 */

function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
}

const { formatFleetAgentModel } = await import('./FleetAgentDirectoryModel')

// Live-catalog shape: entries the daemon serves (alias + id, no description).
const catalog = {
  spawnModels: [
    { alias: 'muse', id: 'muse-spark-1.3-contributor' },
    { alias: 'opus', id: 'claude-opus-5' },
  ],
}

// A row minted before the rename and a row minted after show one name.
equal(formatFleetAgentModel('muse-meta', catalog), 'muse', 'retired alias resolves to current')
equal(formatFleetAgentModel('muse', catalog), 'muse', 'current alias unchanged')

// A raw model id still matches the entry by id.
equal(formatFleetAgentModel('muse-spark-1.3-contributor', catalog), 'muse', 'id matches by id')

// Unmatched strings keep the existing fallback (no catalog, unknown model).
equal(formatFleetAgentModel('muse-meta'), 'muse', 'retired alias resolves without a catalog')
equal(formatFleetAgentModel('opus'), 'opus', 'live alias without a catalog')
equal(formatFleetAgentModel('claude-opus-5-x', catalog), 'opus5x', 'unknown keeps mangled fallback')

// Empty input stays empty.
equal(formatFleetAgentModel(null), '', 'null stays empty')
equal(formatFleetAgentModel(''), '', 'blank stays empty')

console.log('FleetAgentDirectoryModel: 8/8 ok')
