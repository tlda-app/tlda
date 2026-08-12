export const VIRTUOSO_STATUS_ITEM_KEY = '__status__'

export function nextChatVirtuosoFirstItemIndex(previousFirstItemIndex, previousKeys, nextKeys) {
  const previousKeyIndexes = new Map()
  for (let index = 0; index < previousKeys.length; index++) {
    const key = previousKeys[index]
    if (!isVirtuosoIndexAnchorKey(key) || previousKeyIndexes.has(key)) continue
    previousKeyIndexes.set(key, index)
  }

  for (let nextIndex = 0; nextIndex < nextKeys.length; nextIndex++) {
    const key = nextKeys[nextIndex]
    if (!isVirtuosoIndexAnchorKey(key)) continue
    const previousIndex = previousKeyIndexes.get(key)
    if (previousIndex === undefined) continue
    return Math.max(0, previousFirstItemIndex + previousIndex - nextIndex)
  }

  return previousFirstItemIndex
}

function isVirtuosoIndexAnchorKey(key) {
  return key != null && key !== VIRTUOSO_STATUS_ITEM_KEY
}
