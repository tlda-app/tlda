/**
 * A pill source has two intentional outcomes: a stationary touch selects its
 * existing target, while movement hands off to the drag/drop route. Keeping
 * the split here prevents the source surface from inventing a second filter
 * commit path.
 */
export function completePillDrag(drag: { started: boolean } | null, onTap?: () => void): boolean {
  if (!drag) return false
  if (!drag.started) {
    onTap?.()
    return false
  }
  return true
}
