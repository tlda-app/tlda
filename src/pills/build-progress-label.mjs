export function buildProgressLabel({ visible, phase, detail, activityLabel }) {
  if (visible && phase) return `${phase}${detail ? ` ${detail}` : ''}`
  return activityLabel || ''
}
