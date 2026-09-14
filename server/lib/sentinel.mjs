import { upsertShape } from './sync-rooms.mjs'

export const DOC_VERSION_SENTINEL_ID = 'shape:doc-version--sentinel'

const PRESERVED_PROPS = ['sourceRevision', 'acceptSeq', 'errorsJson', 'warningsJson', 'syncErrorJson']

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key)
}

function defaultSentinelShape(patch) {
  return {
    id: DOC_VERSION_SENTINEL_ID,
    typeName: 'shape',
    type: 'doc-version',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a0',
    parentId: 'page:page',
    isLocked: true,
    opacity: 0,
    meta: {},
    props: {
      w: 1,
      h: 1,
      commitHash: patch.commitHash || 'unknown',
      timestamp: patch.timestamp || Date.now(),
      buildReadyAt: patch.buildReadyAt || Date.now(),
      sourceRevision: typeof patch.sourceRevision === 'string' ? patch.sourceRevision : null,
      acceptSeq: Number.isInteger(patch.acceptSeq) ? patch.acceptSeq : 0,
      errorsJson: '',
      warningsJson: '',
      syncErrorJson: '',
    },
  }
}

function mergeSentinel(cur, patch) {
  const curProps = cur?.props || {}
  const nextProps = {
    ...curProps,
    commitHash: hasOwn(patch, 'commitHash') ? patch.commitHash : curProps.commitHash,
    timestamp: hasOwn(patch, 'timestamp') ? patch.timestamp : Date.now(),
    buildReadyAt: hasOwn(patch, 'buildReadyAt') ? patch.buildReadyAt : curProps.buildReadyAt,
  }

  for (const key of PRESERVED_PROPS) {
    if (hasOwn(patch, key)) nextProps[key] = patch[key]
    else if (hasOwn(curProps, key)) nextProps[key] = curProps[key]
  }

  return {
    ...defaultSentinelShape(nextProps),
    ...cur,
    props: {
      ...defaultSentinelShape(nextProps).props,
      ...nextProps,
    },
  }
}

function shouldSkipSentinelWrite(cur, patch) {
  if (!cur) return false
  const curProps = cur.props || {}
  const nextAcceptSeq = patch.acceptSeq
  const curAcceptSeq = curProps.acceptSeq
  const nextReadyAt = patch.buildReadyAt || 0
  const curReadyAt = curProps.buildReadyAt || curProps.timestamp || 0

  if (Number.isInteger(nextAcceptSeq) && Number.isInteger(curAcceptSeq)) {
    if (nextAcceptSeq < curAcceptSeq) return true
    if (nextAcceptSeq === curAcceptSeq && nextReadyAt && curReadyAt >= nextReadyAt) return true
  }

  if (!hasOwn(patch, 'acceptSeq') && nextReadyAt && curReadyAt > nextReadyAt) {
    return true
  }

  return false
}

export function buildSentinelShape(cur, patch) {
  if (shouldSkipSentinelWrite(cur, patch)) return { shape: cur, skipped: true }
  return { shape: mergeSentinel(cur, patch), skipped: false }
}

/**
 * Add or clear a warning of ONE category, preserving every other warning.
 *
 * The merge runs inside the writer's own transaction, against the shape that
 * transaction holds. Computing it outside means read, decide, then write
 * against a sentinel that may have moved in between -- and a read that fails
 * degrades to "no warnings", which erases the render's own. Neither is
 * reachable from in here.
 *
 * `acceptSeq` is required because it is what scopes the write: the staleness
 * rule below drops a patch belonging to a build older than the sentinel's, so
 * a late warning cannot land on a newer build. Without it there is no such
 * protection and nothing is written at all.
 */
export async function writeSentinelWarning(docName, { acceptSeq, category, warning = null }, io = { upsertShape }) {
  if (!Number.isInteger(acceptSeq) || !category) return { skipped: true, reason: 'unscoped' }
  let skipped = false
  await io.upsertShape(docName, DOC_VERSION_SENTINEL_ID, (cur) => {
    let existing = []
    try {
      const parsed = JSON.parse(cur?.props?.warningsJson || '[]')
      if (Array.isArray(parsed)) existing = parsed
    } catch {
      // Unparseable warnings are not a reason to refuse the new one; the
      // alternative is dropping it because an older write was malformed.
      existing = []
    }
    const kept = existing.filter(w => w?.category !== category)
    const next = warning ? [...kept, warning] : kept
    const result = buildSentinelShape(cur, {
      acceptSeq,
      warningsJson: next.length ? JSON.stringify(next) : '',
    })
    skipped = result.skipped
    return result.shape
  })
  return { skipped }
}

/**
 * Single writer-of-record for the doc-version sentinel.
 *
 * It preserves stable status fields unless the patch explicitly changes them
 * and drops stale writes that would move the sentinel behind a newer build.
 */
export async function writeSentinel(docName, patch, io = { upsertShape }) {
  let skipped = false
  await io.upsertShape(docName, DOC_VERSION_SENTINEL_ID, (cur) => {
    const result = buildSentinelShape(cur, patch)
    skipped = result.skipped
    return result.shape
  })
  return { skipped }
}
