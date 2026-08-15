function rectGap(a, b) {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), 0)
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h), 0)
  return Math.hypot(dx, dy)
}

export function horizontalSpatialDocumentPoint(source, occupied, size, worldGap) {
  let x = source.x + source.w + worldGap
  const y = source.y
  while (occupied.some(other => rectGap({ x, y, ...size }, other) < worldGap)) {
    x = Math.max(...occupied.map(other => other.x + other.w)) + worldGap
  }
  return { x, y }
}
