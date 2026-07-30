function syntax(command) {
  return `${command.name}${command.usage ? ` ${command.usage}` : ''}`
}

function validate(command) {
  if (!command || typeof command !== 'object') throw new Error('command definition must be an object')
  for (const field of ['name', 'summary', 'help']) {
    if (typeof command[field] !== 'string' || !command[field].trim()) throw new Error(`command definition requires ${field}`)
  }
  if (!/^[a-z][a-z0-9-]*$/.test(command.name)) throw new Error(`invalid command name "${command.name}"`)
  if (command.aliases?.some(alias => !/^[a-z][a-z0-9-]*$/.test(alias))) throw new Error(`invalid aliases for command "${command.name}"`)
  if (typeof command.handler !== 'function') throw new Error(`command "${command.name}" requires a handler`)
  if (command.authorize != null && typeof command.authorize !== 'function') throw new Error(`command "${command.name}" authorize must be a function`)
}

function tokenize(text) {
  const tokens = []
  let token = ''
  let quote = null
  for (const character of text.trim()) {
    if (quote) {
      if (character === quote) quote = null
      else token += character
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/\s/.test(character)) {
      if (token) tokens.push(token)
      token = ''
    } else token += character
  }
  if (quote) throw new Error('unterminated quoted argument')
  if (token) tokens.push(token)
  return tokens
}

export function createCommandRegistry(definitions = []) {
  const commands = definitions.map(command => ({ aliases: [], usage: '', examples: [], ...command }))
  commands.forEach(validate)
  const byName = new Map()
  for (const command of commands) {
    for (const name of [command.name, ...command.aliases]) {
      if (byName.has(name)) throw new Error(`duplicate command name or alias "${name}"`)
      byName.set(name, command)
    }
  }
  const available = context => commands.filter(command => !command.authorize || command.authorize(context))
  const help = context => [
    'Available commands:',
    ...available(context).map(command => `- \`${syntax(command)}\` — ${command.summary}`),
    '',
    'Use `help <command>` for details.',
  ].join('\n')
  const commandHelp = (name, context) => {
    const command = byName.get(name)
    if (!command || (command.authorize && !command.authorize(context))) return help(context)
    return [
      `\`${syntax(command)}\``,
      '',
      command.help,
      ...(command.examples.length ? ['', 'Examples:', ...command.examples.map(example => `- \`${example}\``)] : []),
    ].join('\n')
  }

  async function dispatch(text, context) {
    let tokens
    try {
      tokens = tokenize(text)
    } catch (error) {
      await context.reply(`${error.message}\n\n${help(context)}`)
      return { ok: false, reason: 'invalid' }
    }
    const requested = (tokens.shift() || 'help').toLowerCase()
    if (requested === 'help') {
      await context.reply(tokens.length ? commandHelp(tokens[0].toLowerCase(), context) : help(context))
      return { ok: true, command: 'help' }
    }
    const command = byName.get(requested)
    if (!command || (command.authorize && !command.authorize(context))) {
      await context.reply(`Unknown command \`${requested}\`.\n\n${help(context)}`)
      return { ok: false, reason: 'unknown' }
    }
    return { ok: true, command: command.name, value: await command.handler({ ...context, args: tokens }) }
  }
  return { commands, dispatch, help, commandHelp }
}

export function generateCommandMarkdown(registry) {
  return registry.commands.map(command => [
    `### \`${syntax(command)}\``,
    '',
    command.summary,
    '',
    command.help,
    ...(command.aliases.length ? ['', `Aliases: ${command.aliases.map(alias => `\`${alias}\``).join(', ')}`] : []),
    ...(command.examples.length ? ['', 'Examples:', '', ...command.examples.map(example => `- \`${example}\``)] : []),
  ].join('\n')).join('\n\n')
}
