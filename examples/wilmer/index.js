import { Client, Embed, BotStatus } from '@voltchat/wire'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BOT_TOKEN  = process.env.WILMER_TOKEN  || 'vbot_your_token_here'
const SERVER_URL = process.env.VOLT_SERVER   || 'http://localhost:5000'

const bot = new Client({ prefix: '!', debug: true })

// In-memory state
const reminders   = []              // { userId, channelId, message, fireAt }
const warnings    = new Map()       // userId -> count
const afkUsers    = new Map()       // userId -> { reason, since }
const polls       = new Map()       // messageId -> { question, options, votes: Map<userId, idx> }
const snipes      = new Map()       // channelId -> { content, username, timestamp }

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function formatUptime(ms) {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

function formatDate(date) {
  return new Date(date).toUTCString()
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function chunkArray(arr, size) {
  const chunks = []
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
  return chunks
}

// ---------------------------------------------------------------------------
// Commands — Information & Utility
// ---------------------------------------------------------------------------

bot.commands.add({
  name: 'ping',
  description: 'Check latency and uptime',
  execute: async (message) => {
    const start = Date.now()
    await message.startTyping()
    await message.reply(`Pong! Latency: **${Date.now() - start}ms** | Uptime: **${formatUptime(bot.uptime)}**`)
  }
})

bot.commands.add({
  name: 'help',
  description: 'List all commands or get help for one',
  usage: '!help [command]',
  execute: async (message, args) => {
    const cmds = bot.commands.toArray()

    if (args[0]) {
      const cmd = cmds.find(c => c.name === args[0].toLowerCase())
      if (!cmd) return message.reply(`Unknown command \`!${args[0]}\``)
      const embed = new Embed()
        .setTitle(`Command: !${cmd.name}`)
        .setDescription(cmd.description || 'No description.')
        .setColor('#f5c542')
        .addField('Usage', `\`${cmd.usage || `!${cmd.name}`}\``)
        .addField('Cooldown', cmd.cooldown ? `${cmd.cooldown}s` : 'None', true)
        .setFooter('@voltchat/wire v1.1')
      return message.reply({ content: '', embeds: [embed.toJSON()] })
    }

    // Paginate into groups of 8
    const pages = chunkArray(cmds, 8)
    const page  = pages[0]
    const list  = page.map(c => `\`!${c.name}\` — ${c.description}`).join('\n')
    const embed = new Embed()
      .setTitle('Wilmer — Commands')
      .setDescription(list)
      .setColor('#f5c542')
      .setFooter(`Page 1/${pages.length} • ${cmds.length} commands total`)
      .setTimestamp()
    await message.reply({ content: '', embeds: [embed.toJSON()] })
  }
})

bot.commands.add({
  name: 'serverinfo',
  description: 'Detailed info about the current server',
  aliases: ['server', 'sinfo'],
  execute: async (message) => {
    if (!message.serverId) return message.reply('This command only works in a server.')

    await message.startTyping()
    let server
    try {
      server = await bot.fetchServer(message.serverId)
    } catch {
      server = { id: message.serverId, name: 'Unknown', members: [], channels: [] }
    }

    const members  = server.members  || []
    const channels = server.channels || []
    const roles    = server.roles    || []
    const bots     = members.filter(m => m.bot)

    const embed = new Embed()
      .setTitle(server.name || 'Server')
      .setColor('#5865f2')
      .addField('ID',       server.id,              true)
      .addField('Owner',    server.ownerId || '—',  true)
      .addField('Members',  String(members.length),  true)
      .addField('Bots',     String(bots.length),     true)
      .addField('Channels', String(channels.length), true)
      .addField('Roles',    String(roles.length),    true)
      .setFooter('Wilmer • @voltchat/wire v1.1')
      .setTimestamp()
    await message.reply({ content: '', embeds: [embed.toJSON()] })
  }
})

bot.commands.add({
  name: 'userinfo',
  description: 'Info about a user',
  usage: '!userinfo [@user or userId]',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('This command only works in a server.')

    const targetId = args[0] || message.userId
    let members
    try { members = await bot.rest.getServerMembers(message.serverId) } catch { members = [] }

    const member = members.find(m => m.id === targetId || m.username?.toLowerCase() === args[0]?.toLowerCase())
    if (!member) return message.reply(`Could not find user \`${args[0] || message.username}\`.`)

    const warnCount = warnings.get(member.id) || 0
    const isAfk     = afkUsers.has(member.id)

    const embed = new Embed()
      .setTitle(member.username)
      .setColor('#57f287')
      .addField('ID',       member.id,                         true)
      .addField('Bot',      member.bot ? 'Yes' : 'No',         true)
      .addField('Warnings', String(warnCount),                  true)
      .addField('AFK',      isAfk ? afkUsers.get(member.id).reason : 'No', true)
      .setFooter('Wilmer • @voltchat/wire v1.1')
      .setTimestamp()
    await message.reply({ content: '', embeds: [embed.toJSON()] })
  }
})

bot.commands.add({
  name: 'members',
  description: 'List server members',
  execute: async (message) => {
    if (!message.serverId) return message.reply('Server only.')
    await message.startTyping()
    let members
    try { members = await bot.fetchMembers(message.serverId) } catch { members = [] }
    if (!members.length) return message.reply('No members found.')
    const list = members.slice(0, 20).map(m => `• **${m.username}**${m.bot ? ' (bot)' : ''}`).join('\n')
    const embed = new Embed()
      .setTitle(`Members (${members.length})`)
      .setDescription(list + (members.length > 20 ? `\n*…and ${members.length - 20} more*` : ''))
      .setColor('#3498db')
      .setTimestamp()
    await message.reply({ content: '', embeds: [embed.toJSON()] })
  }
})

bot.commands.add({
  name: 'botinfo',
  description: 'About Wilmer',
  aliases: ['about', 'info'],
  execute: async (message) => {
    const embed = new Embed()
      .setTitle('About Wilmer')
      .setDescription('Wilmer is a feature-rich example bot built with **@voltchat/wire v1.1**, the official VoltChat bot framework.')
      .setColor('#5865f2')
      .addField('Library',  '@voltchat/wire v1.1.0',                   true)
      .addField('Uptime',   formatUptime(bot.uptime),                   true)
      .addField('Servers',  String(bot.bot?.servers?.length || 0),      true)
      .addField('Commands', String(bot.commands.toArray().length),       true)
      .addField('Reminders', String(reminders.length),                  true)
      .addField('Active Polls', String(polls.size),                     true)
      .setFooter('github.com/Enclicainteractive/Wire')
      .setTimestamp()
    await message.reply({ content: '', embeds: [embed.toJSON()] })
  }
})

// ---------------------------------------------------------------------------
// Commands — Fun & Games
// ---------------------------------------------------------------------------

bot.commands.add({
  name: 'hello',
  description: 'Get a friendly greeting',
  aliases: ['hi', 'hey'],
  execute: async (message, args) => {
    const name = args[0] || message.username
    const greetings = [
      `Hey there, **${name}**! Hope you're having a great day!`,
      `Hello, **${name}**! Welcome to the chat!`,
      `Hi **${name}**! Great to see you here!`,
      `What's up, **${name}**? I'm Wilmer, your friendly neighbourhood bot!`
    ]
    await message.react('👋')
    await message.reply(randomFrom(greetings))
  }
})

bot.commands.add({
  name: 'roll',
  description: 'Roll dice — e.g. !roll 2d20',
  usage: '!roll [NdS]',
  execute: async (message, args) => {
    const spec  = args[0] || '1d6'
    const match = spec.match(/^(\d+)?d(\d+)$/i)
    if (!match) return message.reply('Usage: `!roll NdS` (e.g. `!roll 2d20`)')

    const count = Math.min(parseInt(match[1] || '1'), 100)
    const sides = Math.min(parseInt(match[2]),        1000)
    const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1)
    const total = rolls.reduce((a, b) => a + b, 0)
    await message.reply(`**${spec}** → [ ${rolls.join(', ')} ] = **${total}**`)
  }
})

bot.commands.add({
  name: '8ball',
  description: 'Ask the magic 8-ball',
  aliases: ['ask'],
  usage: '!8ball <question>',
  execute: async (message, args) => {
    if (!args.length) return message.reply('You must ask a question! e.g. `!8ball Will it rain today?`')
    const answers = [
      'It is certain.', 'Without a doubt.', 'Yes, definitely.',
      'You may rely on it.', 'As I see it, yes.', 'Most likely.',
      'Outlook good.', 'Yes.', 'Signs point to yes.',
      'Reply hazy, try again.', 'Ask again later.',
      'Better not tell you now.', 'Cannot predict now.',
      "Don't count on it.", 'My reply is no.', 'My sources say no.',
      'Outlook not so good.', 'Very doubtful.'
    ]
    const embed = new Embed()
      .setTitle('Magic 8-Ball')
      .setColor('#7289da')
      .addField('Question', args.join(' '))
      .addField('Answer',   randomFrom(answers))
    await message.react('🎱')
    await message.reply({ content: '', embeds: [embed.toJSON()] })
  }
})

bot.commands.add({
  name: 'coinflip',
  description: 'Flip a coin',
  aliases: ['flip', 'coin'],
  execute: async (message) => {
    const result = Math.random() < 0.5 ? 'Heads' : 'Tails'
    const emoji  = result === 'Heads' ? '🪙' : '🔵'
    await message.react(emoji)
    await message.reply(`The coin lands on... **${result}**!`)
  }
})

bot.commands.add({
  name: 'rps',
  description: 'Play rock-paper-scissors against the bot',
  usage: '!rps <rock|paper|scissors>',
  execute: async (message, args) => {
    const choices = ['rock', 'paper', 'scissors']
    const player  = args[0]?.toLowerCase()
    if (!choices.includes(player)) {
      return message.reply('Choose `rock`, `paper`, or `scissors`.')
    }
    const bot_choice = randomFrom(choices)
    const wins = { rock: 'scissors', paper: 'rock', scissors: 'paper' }
    let outcome
    if (player === bot_choice)        outcome = "It's a **tie**!"
    else if (wins[player] === bot_choice) outcome = 'You **win**!'
    else                              outcome = 'I **win**!'

    await message.reply(`You chose **${player}**, I chose **${bot_choice}**. ${outcome}`)
  }
})

bot.commands.add({
  name: 'choose',
  description: 'Choose between options',
  usage: '!choose <option1> | <option2> | ...',
  execute: async (message, args) => {
    const options = args.join(' ').split('|').map(s => s.trim()).filter(Boolean)
    if (options.length < 2) return message.reply('Provide at least 2 options separated by `|`.')
    await message.reply(`I choose: **${randomFrom(options)}**`)
  }
})

bot.commands.add({
  name: 'echo',
  description: 'Repeat your message',
  usage: '!echo <text>',
  cooldown: 5,
  execute: async (message, args) => {
    if (!args.length) return message.reply('Usage: `!echo <text>`')
    // Delete the original command for a cleaner effect
    await message.delete().catch(() => {})
    await bot.send(message.channelId, args.join(' '))
  }
})

bot.commands.add({
  name: 'mock',
  description: 'MoCk SoMeOnE\'s TeXt',
  usage: '!mock <text>',
  execute: async (message, args) => {
    if (!args.length) return message.reply('Usage: `!mock <text>`')
    const mocked = args.join(' ').split('').map((c, i) =>
      i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()
    ).join('')
    await message.reply(mocked)
  }
})

// ---------------------------------------------------------------------------
// Commands — Polls
// ---------------------------------------------------------------------------

bot.commands.add({
  name: 'poll',
  description: 'Create a quick poll',
  usage: '!poll <question> | <option1> | <option2> [| option3 ...]',
  execute: async (message, args) => {
    const parts = args.join(' ').split('|').map(s => s.trim()).filter(Boolean)
    if (parts.length < 3) {
      return message.reply('Usage: `!poll <question> | <optionA> | <optionB> [| ...]`')
    }
    const [question, ...options] = parts
    if (options.length > 9) return message.reply('Maximum 9 options per poll.')

    const emojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣']
    const embed  = new Embed()
      .setTitle(`Poll: ${question}`)
      .setDescription(options.map((o, i) => `${emojis[i]} ${o}`).join('\n\n'))
      .setColor('#f5c542')
      .setFooter(`Started by ${message.username} • React with an emoji to vote`)
      .setTimestamp()

    const reply = await message.reply({ content: '', embeds: [embed.toJSON()] })

    // Track poll state
    polls.set(reply?.id || `poll_${Date.now()}`, {
      question,
      options,
      emojis: emojis.slice(0, options.length),
      votes: new Map(),
      channelId: message.channelId,
      createdBy: message.userId
    })

    // React with each option emoji
    for (let i = 0; i < options.length; i++) {
      await bot.rest.addReaction(message.channelId, reply?.id, emojis[i]).catch(() => {})
    }
  }
})

// ---------------------------------------------------------------------------
// Commands — AFK
// ---------------------------------------------------------------------------

bot.commands.add({
  name: 'afk',
  description: 'Set yourself as AFK',
  usage: '!afk [reason]',
  execute: async (message, args) => {
    const reason = args.join(' ') || 'AFK'
    afkUsers.set(message.userId, { reason, since: Date.now() })
    await message.reply(`You are now AFK: **${reason}**`)
  }
})

// ---------------------------------------------------------------------------
// Commands — Reminders
// ---------------------------------------------------------------------------

bot.commands.add({
  name: 'remind',
  description: 'Set a reminder',
  usage: '!remind <time> <message>  (e.g. !remind 10m take a break)',
  execute: async (message, args) => {
    if (args.length < 2) return message.reply('Usage: `!remind <time> <message>`')

    const timeStr = args[0]
    const match   = timeStr.match(/^(\d+)(s|m|h|d)$/)
    if (!match) return message.reply('Invalid time format. Use `10s`, `5m`, `2h`, `1d`.')

    const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 }
    const ms    = parseInt(match[1]) * units[match[2]]
    if (ms > 7 * 24 * 3600000) return message.reply('Maximum reminder time is 7 days.')

    const text = args.slice(1).join(' ')
    reminders.push({ userId: message.userId, channelId: message.channelId, message: text, fireAt: Date.now() + ms })

    setTimeout(async () => {
      await bot.send(message.channelId,
        `Reminder for **${message.username}**: ${text}`
      ).catch(() => {})
    }, ms)

    await message.reply(`Reminder set! I'll remind you in **${timeStr}**: ${text}`)
  }
})

// ---------------------------------------------------------------------------
// Commands — Moderation
// ---------------------------------------------------------------------------

bot.commands.add({
  name: 'warn',
  description: 'Warn a user',
  usage: '!warn <userId> [reason]',
  execute: async (message, args) => {
    if (!args[0]) return message.reply('Usage: `!warn <userId> [reason]`')

    const targetId = args[0]
    const reason   = args.slice(1).join(' ') || 'No reason given'
    const count    = (warnings.get(targetId) || 0) + 1
    warnings.set(targetId, count)

    const embed = new Embed()
      .setTitle('User Warned')
      .setColor('#e67e22')
      .addField('User',    targetId,        true)
      .addField('Reason',  reason,          true)
      .addField('Strikes', `${count}/3`,    true)
      .setFooter(`Warned by ${message.username}`)
      .setTimestamp()

    await message.reply({ content: '', embeds: [embed.toJSON()] })

    if (count >= 3) {
      await bot.send(message.channelId,
        `User \`${targetId}\` has reached **3 warnings**. Consider taking action.`
      )
    }
  }
})

bot.commands.add({
  name: 'warnings',
  description: 'Check warnings for a user',
  usage: '!warnings <userId>',
  execute: async (message, args) => {
    if (!args[0]) return message.reply('Usage: `!warnings <userId>`')
    const count = warnings.get(args[0]) || 0
    await message.reply(`User \`${args[0]}\` has **${count}** warning(s).`)
  }
})

bot.commands.add({
  name: 'clearwarnings',
  description: 'Clear all warnings for a user',
  usage: '!clearwarnings <userId>',
  execute: async (message, args) => {
    if (!args[0]) return message.reply('Usage: `!clearwarnings <userId>`')
    warnings.delete(args[0])
    await message.reply(`Warnings cleared for \`${args[0]}\`.`)
  }
})

bot.commands.add({
  name: 'kick',
  description: 'Kick a member from the server',
  usage: '!kick <userId> [reason]',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('Server only.')
    if (!args[0]) return message.reply('Usage: `!kick <userId> [reason]`')

    const targetId = args[0]
    const reason   = args.slice(1).join(' ') || 'No reason given'

    try {
      await bot.rest.kickMember(message.serverId, targetId, reason)
      await message.reply(`Kicked **${targetId}** — reason: ${reason}`)
    } catch (err) {
      await message.reply(`Failed to kick: ${err.message}`)
    }
  }
})

bot.commands.add({
  name: 'ban',
  description: 'Ban a member from the server',
  usage: '!ban <userId> [reason]',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('Server only.')
    if (!args[0]) return message.reply('Usage: `!ban <userId> [reason]`')

    const targetId = args[0]
    const reason   = args.slice(1).join(' ') || 'No reason given'

    try {
      await bot.rest.banMember(message.serverId, targetId, reason)
      await message.reply(`Banned **${targetId}** — reason: ${reason}`)
    } catch (err) {
      await message.reply(`Failed to ban: ${err.message}`)
    }
  }
})

bot.commands.add({
  name: 'unban',
  description: 'Unban a member',
  usage: '!unban <userId>',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('Server only.')
    if (!args[0]) return message.reply('Usage: `!unban <userId>`')

    try {
      await bot.rest.unbanMember(message.serverId, args[0])
      await message.reply(`Unbanned **${args[0]}**`)
    } catch (err) {
      await message.reply(`Failed to unban: ${err.message}`)
    }
  }
})

bot.commands.add({
  name: 'purge',
  description: 'Delete the last N messages (up to 20)',
  usage: '!purge <count>',
  execute: async (message, args) => {
    const count = Math.min(parseInt(args[0]) || 1, 20)
    if (isNaN(count) || count < 1) return message.reply('Usage: `!purge <1-20>`')

    // Delete the command message itself first
    await message.delete().catch(() => {})
    await message.reply(`Purge of **${count}** messages requested. (Server must persist message history for full effect.)`).catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Commands — Utility
// ---------------------------------------------------------------------------

bot.commands.add({
  name: 'snipe',
  description: 'Show the last deleted message in this channel',
  execute: async (message) => {
    const sniped = snipes.get(message.channelId)
    if (!sniped) return message.reply('Nothing to snipe in this channel.')

    const embed = new Embed()
      .setTitle('Last deleted message')
      .setDescription(sniped.content || '*(no text content)*')
      .setColor('#e74c3c')
      .addField('Author',  sniped.username,          true)
      .addField('Deleted', formatDate(sniped.timestamp), true)
      .setFooter('Wilmer Snipe')
    await message.reply({ content: '', embeds: [embed.toJSON()] })
  }
})

bot.commands.add({
  name: 'status',
  description: 'Change the bot\'s status',
  usage: '!status <online|idle|dnd|offline> [custom text]',
  execute: async (message, args) => {
    const valid = ['online', 'idle', 'dnd', 'offline']
    const s     = args[0]?.toLowerCase()
    if (!valid.includes(s)) return message.reply(`Valid statuses: ${valid.join(', ')}`)

    const customStatus = args.slice(1).join(' ') || undefined
    await bot.setStatus(s, customStatus)
    await message.reply(`Status set to **${s}**${customStatus ? `: ${customStatus}` : ''}`)
  }
})

bot.commands.add({
  name: 'channels',
  description: 'List channels in the server',
  execute: async (message) => {
    if (!message.serverId) return message.reply('Server only.')
    await message.startTyping()
    let channels
    try { channels = await bot.fetchChannels(message.serverId) } catch { channels = [] }
    if (!Array.isArray(channels) || !channels.length) return message.reply('No channels found.')
    const list = channels.slice(0, 20).map(c => `• **#${c.name}** (\`${c.id}\`)`).join('\n')
    const embed = new Embed()
      .setTitle(`Channels (${channels.length})`)
      .setDescription(list)
      .setColor('#3498db')
      .setTimestamp()
    await message.reply({ content: '', embeds: [embed.toJSON()] })
  }
})

bot.commands.add({
  name: 'react',
  description: 'Add a reaction to the previous message',
  usage: '!react <emoji>',
  execute: async (message, args) => {
    if (!args[0]) return message.reply('Usage: `!react <emoji>`')
    await message.react(args[0])
  }
})

bot.commands.add({
  name: 'pin',
  description: 'Pin the bot\'s next reply',
  usage: '!pin <text>',
  execute: async (message, args) => {
    if (!args.length) return message.reply('Usage: `!pin <text>`')
    const sent = await message.reply(args.join(' '))
    if (sent?.id) {
      await bot.rest.pinMessage(message.channelId, sent.id).catch(() => {})
    }
  }
})

// ---------------------------------------------------------------------------
// Auto-moderation — basic link / caps filter
// ---------------------------------------------------------------------------

const BLOCKED_PATTERNS = [
  /discord\.gg\/\S+/i,   // Discord invite links
]

const CAPS_THRESHOLD = 0.7  // 70% caps triggers warning

function isSpam(text) {
  if (!text || text.length < 8) return false
  const letters = text.replace(/[^a-zA-Z]/g, '')
  if (letters.length < 6) return false
  return (letters.replace(/[^A-Z]/g, '').length / letters.length) > CAPS_THRESHOLD
}

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

bot.commands.onError(async (err, message, cmd) => {
  console.error(`[Wilmer] Command error in !${cmd.name}:`, err)
  await message.reply(`Something went wrong running \`!${cmd.name}\`. Please try again.`)
})

// ---------------------------------------------------------------------------
// Gateway events
// ---------------------------------------------------------------------------

bot.on('ready', (info) => {
  console.log(`[Wilmer] Online as ${info.name} (${info.id || info.botId})`)
  console.log(`[Wilmer] Serving ${info.servers?.length || 0} servers`)
  console.log(`[Wilmer] ${bot.commands.toArray().length} commands registered`)
})

bot.on('message', async (message) => {
  // AFK return detection
  if (afkUsers.has(message.userId)) {
    const afk = afkUsers.get(message.userId)
    afkUsers.delete(message.userId)
    const duration = formatUptime(Date.now() - afk.since)
    await bot.send(message.channelId,
      `Welcome back, **${message.username}**! You were AFK for **${duration}**.`
    ).catch(() => {})
  }

  // Auto-mod: blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(message.content)) {
      await message.delete().catch(() => {})
      await bot.send(message.channelId,
        `**${message.username}**, that link is not allowed here.`
      ).catch(() => {})
      return
    }
  }

  // Auto-mod: excessive caps
  if (isSpam(message.content)) {
    const count = (warnings.get(message.userId) || 0) + 1
    warnings.set(message.userId, count)
    await bot.send(message.channelId,
      `**${message.username}**, please avoid excessive caps! (Warning ${count}/3)`
    ).catch(() => {})
  }
})

bot.on('messageDelete', (data) => {
  // Store for !snipe
  if (data.content) {
    snipes.set(data.channelId, {
      content:   data.content,
      username:  data.username || 'Unknown',
      timestamp: Date.now()
    })
  }
})

bot.on('memberJoin', async (data) => {
  console.log(`[Wilmer] Member joined: ${data.username} in server ${data.serverId}`)
})

bot.on('memberLeave', (data) => {
  console.log(`[Wilmer] Member left: ${data.username || data.userId}`)
  afkUsers.delete(data.userId || data.id)
})

bot.on('reactionAdd', (data) => {
  // Tally poll votes
  for (const [pollId, poll] of polls.entries()) {
    const emojiIdx = poll.emojis.indexOf(data.emoji)
    if (emojiIdx === -1) continue
    poll.votes.set(data.userId, emojiIdx)
  }
})

bot.on('typingStart', (data) => {
  // Could be used for activity tracking; logged at debug level
})

bot.on('voiceJoin', (data) => {
  console.log(`[Wilmer] Voice join: ${data.username || data.userId} -> channel ${data.channelId}`)
})

bot.on('voiceLeave', (data) => {
  console.log(`[Wilmer] Voice leave: ${data.username || data.userId}`)
})

bot.on('channelCreate', (data) => {
  console.log(`[Wilmer] Channel created: #${data.name} (${data.id})`)
})

bot.on('channelDelete', (data) => {
  console.log(`[Wilmer] Channel deleted: ${data.channelId}`)
  snipes.delete(data.channelId)
})

bot.on('serverUpdate', (data) => {
  console.log(`[Wilmer] Server updated: ${data.id}`)
})

bot.on('error', (err) => {
  console.error('[Wilmer] Error:', err.message)
  if (err.gatewayUrl)  console.error('[Wilmer]   Gateway URL :', err.gatewayUrl)
  if (err.detail)      console.error('[Wilmer]   Detail      :', err.detail)
  if (err.cause)       console.error('[Wilmer]   Cause       :', err.cause?.message ?? err.cause)
  if (err.stack)       console.error('[Wilmer]   Stack       :', err.stack)
})

bot.on('disconnect', (reason) => {
  console.log('[Wilmer] Disconnected:', reason)
})

bot.on('reconnect', () => {
  console.log('[Wilmer] Reconnected.')
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

console.log(`[Wilmer] Starting — server: ${SERVER_URL}`)

bot.login(BOT_TOKEN, SERVER_URL).catch(err => {
  console.error('[Wilmer] Failed to start:', err.message)
  if (err.gatewayUrl)  console.error('[Wilmer]   Gateway URL :', err.gatewayUrl)
  if (err.detail)      console.error('[Wilmer]   Detail      :', err.detail)
  if (err.cause)       console.error('[Wilmer]   Cause       :', err.cause?.message ?? err.cause)
  if (err.stack)       console.error('[Wilmer]   Stack       :\n', err.stack)
  process.exit(1)
})
