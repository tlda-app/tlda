export function registeredDropTargetFromElements(elements, targetForElement, payload) {
  for (const hit of elements) {
    let element = hit
    while (element) {
      const target = targetForElement(element)
      if (target?.accepts(payload)) return { element, target }
      element = element.parentElement
    }
  }
  return null
}
