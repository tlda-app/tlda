import { putShape, updateShape } from './sync-rooms.mjs'

export const DOC_VERSION_SENTINEL_ID = 'shape:doc-version--sentinel'

const PRESERVED_PROPS = ['sourceVersion', 'errorsJson', 'warningsJson', 'syncErrorJson']

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
      sourceVersion: typeof patch.sourceVersion === 'number' ? patch.sourceVersion : 0,
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
  const nextSourceVersion = patch.sourceVersion
  const curSourceVersion = curProps.sourceVersion
  const nextReadyAt = patch.buildReadyAt || 0
  const curReadyAt = curProps.buildReadyAt || curProps.timestamp || 0

  if (typeof nextSourceVersion === 'number' && typeof curSourceVersion === 'number') {
    if (nextSourceVersion < curSourceVersion) return true
    if (nextSourceVersion === curSourceVersion && nextReadyAt && curReadyAt >= nextReadyAt) return true
  }

  if (!hasOwn(patch, 'sourceVersion') && nextReadyAt && curReadyAt > nextReadyAt) {
    return true
  }

  return false
}

export function buildSentinelShape(cur, patch) {
  if (shouldSkipSentinelWrite(cur, patch)) return { shape: cur, skipped: true }
  return { shape: mergeSentinel(cur, patch), skipped: false }
}

/**
 * Single writer-of-record for the doc-version sentinel.
 *
 * It preserves stable status fields unless the patch explicitly changes them
 * and drops stale writes that would move the sentinel behind a newer build.
 */
export async function writeSentinel(docName, patch, io = { updateShape, putShape }) {
  let skipped = false
  try {
    await io.updateShape(docName, DOC_VERSION_SENTINEL_ID, (cur) => {
      const result = buildSentinelShape(cur, patch)
      skipped = result.skipped
      return result.shape
    })
  } catch (e) {
    if (!/not found/i.test(e?.message || '')) throw e
    const result = buildSentinelShape(null, patch)
    skipped = result.skipped
    if (!skipped) await io.putShape(docName, result.shape)
  }
  return { skipped }
}
