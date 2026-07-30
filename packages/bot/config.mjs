export function defineConfig(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('configuration fields must be an object')
  for (const [name, field] of Object.entries(fields)) {
    if (!field?.env || !field?.description || typeof field.parse !== 'function') {
      throw new Error(`configuration field "${name}" requires env, description, and parse`)
    }
  }
  return { fields }
}

export function parseConfig(schema, env = process.env) {
  const config = {}
  const errors = []
  for (const [name, field] of Object.entries(schema.fields)) {
    const raw = env[field.env]
    try {
      if ((raw == null || raw === '') && field.default === undefined) throw new Error('is required')
      config[name] = raw == null || raw === '' ? field.default : field.parse(raw)
      if (field.validate && !field.validate(config[name])) throw new Error('is invalid')
    } catch (error) {
      errors.push(`${field.env} ${error.message}`)
    }
  }
  if (errors.length) throw new Error(`invalid bot configuration:\n- ${errors.join('\n- ')}`)
  return Object.freeze(config)
}

export const configTypes = {
  string: value => String(value),
  boolean: value => {
    if (value === '1' || value === 'true') return true
    if (value === '0' || value === 'false') return false
    throw new Error('must be 0, 1, true, or false')
  },
  integer: value => {
    if (!/^-?\d+$/.test(value)) throw new Error('must be an integer')
    return Number(value)
  },
}

export function generateConfigMarkdown(schema) {
  return Object.entries(schema.fields).map(([name, field]) => {
    const defaultValue = field.default === undefined ? 'required' : `\`${JSON.stringify(field.default)}\``
    return `- \`${field.env}\` (${name}; default: ${defaultValue}) — ${field.description}`
  }).join('\n')
}
