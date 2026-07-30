export function terminalInputAllowedFromConfig(config = {}) {
  return config?.terminalInputAllowed === true
}

const NON_TEXT_KEY_NAMES = new Set([
  'BTab',
  'Backspace',
  'BSpace',
  'Cancel',
  'Clear',
  'C-End',
  'C-Home',
  'C-Left',
  'C-Right',
  'Delete',
  'DC',
  'Down',
  'End',
  'Enter',
  'Escape',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
  'Home',
  'IC',
  'Insert',
  'Left',
  'NPage',
  'PPage',
  'PageDown',
  'PageUp',
  'Right',
  'Tab',
  'Up',
])

function normalizedKeyName(key) {
  return typeof key === 'string' ? key.trim() : ''
}

export function sendKeyAllowedWithoutTextInput(key) {
  const value = normalizedKeyName(key)
  if (!value) return false
  if (NON_TEXT_KEY_NAMES.has(value)) return true
  if (/^C-[A-Za-z]$/.test(value)) return true
  if (/^M-(?:[A-Za-z]|C-[A-Za-z]|Left|Right|Up|Down|Home|End|PageUp|PageDown|PPage|NPage)$/.test(value)) return true
  return false
}

export function assertTerminalTextInputAllowed(terminalInputAllowed, operation, detail = {}) {
  if (terminalInputAllowed) return
  if (operation === 'send-key' && sendKeyAllowedWithoutTextInput(detail.key)) return
  throw new Error('terminal text input is disabled by this daemon')
}
