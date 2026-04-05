// Webhook emitter — notifies fleet dashboard of tlda events
// Events: build-complete, shape-changed, annotation-added

const FLEET_WEBHOOK_URL = process.env.FLEET_WEBHOOK_URL || 'http://localhost:5199/api/webhook/tlda';

// Annotation shape types — shapes that represent user feedback
const ANNOTATION_TYPES = new Set(['math-note', 'understanding-line', 'reading-assist-bar', 'highlight']);

export async function emitWebhook(eventType, data) {
  try {
    const res = await fetch(FLEET_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType, data, timestamp: Date.now() }),
    });
    if (!res.ok) {
      console.error(`[webhook] ${eventType}: fleet returned ${res.status}`);
    }
  } catch (e) {
    // Fleet not running — silently ignore
    if (e.code !== 'ECONNREFUSED') {
      console.error(`[webhook] ${eventType}: ${e.message}`);
    }
  }
}

export function emitBuildComplete(projectName, { status, elapsed, pages, errors }) {
  return emitWebhook('build-complete', { projectName, status, elapsed, pages, errors });
}

export function emitShapeChanged(docName, changes) {
  // Filter to interesting changes only (skip camera, pointer, etc.)
  const interesting = (changes || []).filter(c => c.type === 'shape');
  if (interesting.length === 0) return;

  // Check if any are annotations — emit separate event
  const annotations = interesting.filter(c => c.action === 'create' && ANNOTATION_TYPES.has(c.shapeType));
  if (annotations.length > 0) {
    for (const a of annotations) {
      emitWebhook('annotation-added', { docName, change: a });
    }
  }

  // Emit general shape-changed (debounced per doc to avoid flooding)
  emitWebhook('shape-changed', { docName, changes: interesting.slice(0, 10) });
}

// Debounced shape change emitter — batches rapid changes
const _shapeTimers = new Map();
export function emitShapeChangedDebounced(docName, changes) {
  const interesting = (changes || []).filter(c => c.type === 'shape');
  if (interesting.length === 0) return;

  // Annotations always emit immediately
  const annotations = interesting.filter(c => c.action === 'create' && ANNOTATION_TYPES.has(c.shapeType));
  for (const a of annotations) {
    emitWebhook('annotation-added', { docName, change: a });
  }

  // Batch general shape changes with 2s debounce
  const existing = _shapeTimers.get(docName);
  if (existing) {
    existing.changes.push(...interesting);
    clearTimeout(existing.timer);
  } else {
    _shapeTimers.set(docName, { changes: [...interesting] });
  }

  const entry = _shapeTimers.get(docName);
  entry.timer = setTimeout(() => {
    emitWebhook('shape-changed', { docName, changes: entry.changes.slice(0, 20) });
    _shapeTimers.delete(docName);
  }, 2000);
}
