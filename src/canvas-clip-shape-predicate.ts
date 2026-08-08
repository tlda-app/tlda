export interface CanvasClipShapeLike {
  type: string
}

export function createCanvasClipShapePredicate<T extends CanvasClipShapeLike>({
  lockCamera,
  readOnly,
  hostShapePredicate,
}: {
  lockCamera: boolean
  readOnly: boolean
  hostShapePredicate?: (shape: T) => boolean
}): ((shape: T) => boolean) | undefined {
  if (!lockCamera && !readOnly) return undefined

  return (shape: T) => {
    if (hostShapePredicate) return hostShapePredicate(shape)
    if (lockCamera) return false
    return true
  }
}
