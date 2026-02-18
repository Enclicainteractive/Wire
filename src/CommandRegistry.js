export class Command {
  constructor(options) {
    this.name = options.name
    this.description = options.description || ''
    this.usage = options.usage || ''
    this.aliases = options.aliases || []
    this.cooldown = options.cooldown || 0
    this.permissions = options.permissions || []
    this.execute = options.execute
    this._cooldowns = new Map()
  }

  isOnCooldown(userId) {
    if (!this.cooldown) return false
    const last = this._cooldowns.get(userId)
    if (!last) return false
    return Date.now() - last < this.cooldown * 1000
  }

  getCooldownRemaining(userId) {
    const last = this._cooldowns.get(userId)
    if (!last) return 0
    const remaining = this.cooldown * 1000 - (Date.now() - last)
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0
  }

  setCooldown(userId) {
    if (this.cooldown) {
      this._cooldowns.set(userId, Date.now())
    }
  }
}

export class CommandRegistry {
  constructor(prefix = '!') {
    this.prefix = prefix
    this.commands = new Map()
    this._errorHandler = null
  }

  add(nameOrOptions, executeOrUndefined) {
    let cmd
    if (typeof nameOrOptions === 'string') {
      cmd = new Command({ name: nameOrOptions, execute: executeOrUndefined })
    } else if (nameOrOptions instanceof Command) {
      cmd = nameOrOptions
    } else {
      cmd = new Command(nameOrOptions)
    }

    this.commands.set(cmd.name, cmd)
    for (const alias of cmd.aliases) {
      this.commands.set(alias, cmd)
    }
    return this
  }

  remove(name) {
    const cmd = this.commands.get(name)
    if (cmd) {
      this.commands.delete(cmd.name)
      for (const alias of cmd.aliases) {
        this.commands.delete(alias)
      }
    }
    return this
  }

  onError(handler) {
    this._errorHandler = handler
    return this
  }

  async handle(message) {
    if (!message.content.startsWith(this.prefix)) return false
    if (message.bot) return false

    const parsed = message.parseCommand(this.prefix)
    if (!parsed || !parsed.name) return false

    const cmd = this.commands.get(parsed.name)
    if (!cmd) return false

    if (cmd.isOnCooldown(message.userId)) {
      const remaining = cmd.getCooldownRemaining(message.userId)
      await message.reply(`Please wait ${remaining}s before using \`${this.prefix}${cmd.name}\` again.`)
      return true
    }

    try {
      await cmd.execute(message, parsed.args, {
        command: cmd,
        prefix: this.prefix,
        raw: parsed.raw
      })
      cmd.setCooldown(message.userId)
    } catch (err) {
      if (this._errorHandler) {
        this._errorHandler(err, message, cmd)
      } else {
        console.error(`[Wire] Command error (${cmd.name}):`, err)
      }
    }

    return true
  }

  toArray() {
    const seen = new Set()
    const result = []
    for (const cmd of this.commands.values()) {
      if (seen.has(cmd.name)) continue
      seen.add(cmd.name)
      result.push({
        name: cmd.name,
        description: cmd.description,
        usage: cmd.usage
      })
    }
    return result
  }
}
