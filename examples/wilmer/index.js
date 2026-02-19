import { Client, Embed, BotStatus } from '@voltchat/wire'
import fs from 'fs'
import https from 'https'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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
// Voice connections are managed by bot.joinVoice() / bot.leaveVoice() via Wire

const mediaQueues = new Map() // serverId -> { audio: [], video: [], currentAudio: {}, currentVideo: {}, loop: false, loopSingle: false, shuffle: false, volume: 1.0, paused: false, audioPlayer: null, videoPlayer: null }

function getQueue(serverId) {
  if (!mediaQueues.has(serverId)) {
    mediaQueues.set(serverId, {
      audio: [],
      video: [],
      currentAudio: null,
      currentVideo: null,
      loop: false,
      loopSingle: false,
      shuffle: false,
      volume: 1.0,
      paused: false,
      audioPlayer: null,
      videoPlayer: null,
    })
  }
  return mediaQueues.get(serverId)
}

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
  usage: '!help [command|page]',
  execute: async (message, args) => {
    const cmds = bot.commands.toArray()

    // If the first arg is a number, treat it as a page number
    const pageNum = args[0] && /^\d+$/.test(args[0]) ? parseInt(args[0]) : null

    if (args[0] && pageNum === null) {
      // Specific command lookup
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
    const pages   = chunkArray(cmds, 8)
    const total   = pages.length
    const idx     = pageNum ? Math.min(Math.max(pageNum, 1), total) - 1 : 0
    const page    = pages[idx]
    const list    = page.map(c => `\`!${c.name}\` — ${c.description}`).join('\n')
    const embed   = new Embed()
    .setTitle('Wilmer — Commands')
    .setDescription(list)
    .setColor('#f5c542')
    .setFooter(`Page ${idx + 1}/${total} • ${cmds.length} commands total${idx + 1 < total ? ` • Use \`!help ${idx + 2}\` for next page` : ''}`)
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
// Commands — Voice & Audio Queue
// ---------------------------------------------------------------------------

const AUDIO_DIR = './audio'
const VIDEO_DIR = './video'

bot.commands.add({
  name: 'joinvoice',
  description: 'Join a voice channel',
  aliases: ['jv', 'join', 'connect'],
  usage: '!joinvoice <channelId|channelName>',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      if (!args[0]) return message.reply('Usage: `!joinvoice <channelId|channelName>`')

        const serverId = message.serverId
        let channelId  = args[0]

        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        if (!UUID_RE.test(channelId)) {
          const nameLower = channelId.toLowerCase()
          if (bot.channels.size === 0) {
            await bot.fetchChannels(serverId).catch(() => {})
          }
          const found = [...bot.channels.values()].find(
            c => c.name?.toLowerCase() === nameLower || c.name?.toLowerCase().includes(nameLower)
          )
          if (!found) {
            return message.reply(`Could not find a voice channel matching \`${channelId}\`. Use a channel ID or exact name.`)
          }
          channelId = found.id
        }

        let vc
        try {
          vc = await bot.joinVoice(serverId, channelId)
        } catch (err) {
          console.error('[Wilmer] joinVoice error:', err.message)
          return message.reply(`Failed to join voice: ${err.message}`)
        }

        vc.removeAllListeners('finish')
        vc.removeAllListeners('error')
        vc.removeAllListeners('peerJoin')
        vc.removeAllListeners('peerLeave')

        vc.on('finish', () => {
          const queue = getQueue(serverId)
          if (queue.loop && queue.audio.length > 0) {
            const first = queue.audio[0]
            vc.playFile(first.path).catch(() => {})
          } else if (queue.audio.length > 1) {
            queue.audio.shift()
            playNextAudio(serverId, vc)
          } else {
            queue.currentAudio = null
            queue.audioPlayer = null
          }
        })

        vc.on('error', (err) => {
          console.error('[Wilmer] Voice error in channel', channelId, ':', err.message)
        })

        vc.on('peerJoin', (peerId) => {
          console.log(`[Wilmer] Peer joined voice: ${peerId}`)
        })

        vc.on('peerLeave', (peerId) => {
          console.log(`[Wilmer] Peer left voice: ${peerId}`)
        })

        await message.reply(`Joined voice channel \`${channelId}\`. Use \`!play <file or url>\` to play audio.`)
  }
})

async function playNextAudio(serverId, vc) {
  const queue = getQueue(serverId)
  if (queue.audio.length === 0) {
    queue.currentAudio = null
    queue.audioPlayer = null
    return
  }

  const next = queue.audio[0]
  queue.currentAudio = next

  try {
    await vc.playFile(next.path, { loop: queue.loop && queue.audio.length === 1 })
    queue.audioPlayer = vc._player
    if (queue.paused && vc._player) {
      vc._player._paused = true
      vc._player._timer && clearInterval(vc._player._timer)
    }
  } catch (err) {
    console.error('[Wilmer] playNextAudio error:', err.message)
    queue.audio.shift()
    playNextAudio(serverId, vc)
  }
}

function getAudioFiles() {
  try {
    const files = fs.readdirSync(AUDIO_DIR).filter(f => f.endsWith('.mp3') || f.endsWith('.wav') || f.endsWith('.ogg') || f.endsWith('.flac'))
    return files
  } catch {
    return []
  }
}

bot.commands.add({
  name: 'play',
  description: 'Play audio from file or URL',
  aliases: ['p'],
  usage: '!play <filename> or <url>',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      if (!args[0]) return message.reply('Usage: `!play <filename>` or `!play <url>`')

        const serverId = message.serverId
        const queue = getQueue(serverId)

        let vc = bot.getVoiceConnection(serverId)
        if (!vc) {
          const channels = await bot.fetchChannels(serverId).catch(() => [])
          const voiceChannel = channels?.find(c => c.name?.toLowerCase().includes('general') || c.name?.toLowerCase().includes('voice'))
          if (!voiceChannel) return message.reply('No voice channel found. Use `!joinvoice <channel>` first.')
          
          try {
            vc = await bot.joinVoice(serverId, voiceChannel.id)
          } catch (err) {
            return message.reply(`Failed to join voice: ${err.message}`)
          }
        }

        const input = args.join(' ')
        let filePath = input
        let isUrl = input.startsWith('http://') || input.startsWith('https://')

        if (!isUrl) {
          const files = getAudioFiles()
          const match = files.find(f => f.toLowerCase().replace(/\.[^.]+$/, '') === input.toLowerCase().replace(/\.[^.]+$/, ''))
          if (match) {
            filePath = `${AUDIO_DIR}/${match}`
          } else {
            const fuzzy = files.find(f => f.toLowerCase().includes(input.toLowerCase()))
            if (fuzzy) {
              filePath = `${AUDIO_DIR}/${fuzzy}`
            } else {
              return message.reply(`Audio file not found. Available: ${files.join(', ') || 'none'}`)
            }
          }
        }

        const track = {
          path: filePath,
          name: isUrl ? input.split('/').pop() || 'URL' : filePath.split('/').pop(),
          url: isUrl ? input : null,
          requestedBy: message.username,
        }

        queue.audio.push(track)

        if (!queue.currentAudio) {
          queue.currentAudio = track
          try {
            await vc.playFile(track.path, { loop: queue.loop })
            queue.audioPlayer = vc._player
            await message.reply(`Now playing: **${track.name}**`)
          } catch (err) {
            queue.audio.shift()
            return message.reply(`Failed to play: ${err.message}`)
          }
        } else {
          await message.reply(`Added to queue: **${track.name}** (position ${queue.audio.length})`)
        }
  }
})

bot.commands.add({
  name: 'queue',
  description: 'Show the audio queue',
  aliases: ['q', 'list'],
  execute: async (message) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      const queue = getQueue(message.serverId)
      
      if (!queue.currentAudio && queue.audio.length === 0) {
        return message.reply('Queue is empty.')
      }

      let desc = ''
      if (queue.currentAudio) {
        desc += `**Now Playing:** ${queue.currentAudio.name}\n`
        if (queue.paused) desc += '(Paused)\n'
        if (queue.loop) desc += `Loop: ${queue.loopSingle ? 'single' : 'all'}\n`
        desc += `Volume: ${Math.round(queue.volume * 100)}%\n\n`
      }

      if (queue.audio.length > 0) {
        desc += '**Up Next:**\n'
        queue.audio.slice(0, 15).forEach((t, i) => {
          desc += `${i + 1}. ${t.name} (${t.requestedBy})\n`
        })
        if (queue.audio.length > 15) desc += `...and ${queue.audio.length - 15} more`
      }

      const embed = new Embed()
        .setTitle('Audio Queue')
        .setDescription(desc)
        .setColor('#5865f2')
        .setFooter(`Total: ${queue.audio.length} track(s)`)
      await message.reply({ content: '', embeds: [embed.toJSON()] })
  }
})

bot.commands.add({
  name: 'skip',
  description: 'Skip to the next track',
  aliases: ['s', 'next'],
  execute: async (message) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      const queue = getQueue(message.serverId)
      const vc = bot.getVoiceConnection(message.serverId)
      
      if (!vc || !queue.currentAudio) return message.reply('Nothing playing.')
      
      vc.stopAudio()
      queue.audio.shift()
      
      if (queue.audio.length > 0) {
        await playNextAudio(message.serverId, vc)
        await message.reply(`Skipped. Now playing: **${queue.currentAudio.name}**`)
      } else {
        queue.currentAudio = null
        await message.reply('Skipped. Queue empty.')
      }
  }
})

bot.commands.add({
  name: 'pause',
  description: 'Pause audio playback',
  aliases: ['paused'],
  execute: async (message) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      const queue = getQueue(message.serverId)
      const vc = bot.getVoiceConnection(message.serverId)
      
      if (!vc || !queue.currentAudio) return message.reply('Nothing playing.')
      if (queue.paused) return message.reply('Already paused.')
      
      queue.paused = true
      if (vc._player) {
        vc._player._paused = true
        if (vc._player._timer) {
          clearInterval(vc._player._timer)
          vc._player._timer = null
        }
      }
      await message.reply('Playback paused.')
  }
})

bot.commands.add({
  name: 'resume',
  description: 'Resume audio playback',
  aliases: ['unpause'],
  execute: async (message) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      const queue = getQueue(message.serverId)
      const vc = bot.getVoiceConnection(message.serverId)
      
      if (!vc || !queue.currentAudio) return message.reply('Nothing playing.')
      if (!queue.paused) return message.reply('Not paused.')
      
      queue.paused = false
      if (vc._player) {
        vc._player._paused = false
        vc._player._timer = setInterval(() => vc._player._pump(), 10)
      }
      await message.reply('Playback resumed.')
  }
})

bot.commands.add({
  name: 'volume',
  description: 'Set volume (0-200)',
  aliases: ['vol'],
  usage: '!volume <0-200>',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      const queue = getQueue(message.serverId)
      
      if (!args[0]) return message.reply(`Current volume: ${Math.round(queue.volume * 100)}%`)
      
      const vol = parseInt(args[0])
      if (isNaN(vol) || vol < 0 || vol > 200) return message.reply('Volume must be between 0 and 200.')
      
      queue.volume = vol / 100
      if (queue.audioPlayer) {
        queue.audioPlayer._volume = queue.volume
      }
      await message.reply(`Volume set to **${vol}%**`)
  }
})

bot.commands.add({
  name: 'loop',
  description: 'Toggle loop mode (off/single/all)',
  aliases: ['repeat', 'loopall'],
  usage: '!loop [off|single|all]',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      const queue = getQueue(message.serverId)
      
      const mode = args[0]?.toLowerCase()
      
      if (!mode || mode === 'toggle') {
        if (queue.loop) {
          if (queue.loopSingle) {
            queue.loop = false
            queue.loopSingle = false
            await message.reply('Loop disabled.')
          } else {
            queue.loopSingle = true
            await message.reply('Loop mode: **single track**')
          }
        } else {
          queue.loop = true
          await message.reply('Loop mode: **all tracks**')
        }
      } else if (mode === 'off' || mode === 'disable') {
        queue.loop = false
        queue.loopSingle = false
        await message.reply('Loop disabled.')
      } else if (mode === 'single' || mode === '1') {
        queue.loop = true
        queue.loopSingle = true
        await message.reply('Loop mode: **single track**')
      } else if (mode === 'all' || mode === 'on') {
        queue.loop = true
        queue.loopSingle = false
        await message.reply('Loop mode: **all tracks**')
      } else {
        await message.reply('Usage: `!loop [off|single|all]`')
      }
  }
})

bot.commands.add({
  name: 'shuffle',
  description: 'Shuffle the queue',
  execute: async (message) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      const queue = getQueue(message.serverId)
      
      if (queue.audio.length < 2) return message.reply('Need at least 2 tracks to shuffle.')
      
      for (let i = queue.audio.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue.audio[i], queue.audio[j]] = [queue.audio[j], queue.audio[i]]
      }
      
      await message.reply('Queue shuffled!')
  }
})

bot.commands.add({
  name: 'remove',
  description: 'Remove a track from queue',
  usage: '!remove <position>',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      const queue = getQueue(message.serverId)
      
      if (!args[0]) return message.reply('Usage: `!remove <position>`')
      
      const idx = parseInt(args[0]) - 1
      if (isNaN(idx) || idx < 0 || idx >= queue.audio.length) {
        return message.reply(`Invalid position. Queue has ${queue.audio.length} track(s).`)
      }
      
      const removed = queue.audio.splice(idx, 1)[0]
      await message.reply(`Removed: **${removed.name}**`)
  }
})

bot.commands.add({
  name: 'clearqueue',
  description: 'Clear the audio queue',
  aliases: ['cq', 'clear'],
  execute: async (message) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      const queue = getQueue(message.serverId)
      
      const count = queue.audio.length
      queue.audio = []
      queue.currentAudio = null
      
      const vc = bot.getVoiceConnection(message.serverId)
      if (vc) vc.stopAudio()
      
      await message.reply(`Cleared ${count} track(s) from queue.`)
  }
})

bot.commands.add({
  name: 'audiolist',
  description: 'List available audio files',
  aliases: ['audios', 'files'],
  execute: async (message) => {
    const files = getAudioFiles()
    
    if (files.length === 0) {
      return message.reply('No audio files found in ./audio folder.')
    }
    
    const embed = new Embed()
      .setTitle('Available Audio Files')
      .setDescription(files.map((f, i) => `${i + 1}. ${f}`).join('\n'))
      .setColor('#57f287')
      .setFooter(`${files.length} file(s)`)
    await message.reply({ content: '', embeds: [embed.toJSON()] })
  }
})

bot.commands.add({
  name: 'leavevoice',
  description: 'Leave the voice channel in this server',
  aliases: ['lv', 'leave', 'disconnect', 'dc'],
  execute: async (message) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      const vc = bot.getVoiceConnection(message.serverId)
      if (!vc) return message.reply('I am not in a voice channel in this server.')
        const channelId = vc.channelId
        await bot.leaveVoice(message.serverId)
        mediaQueues.delete(message.serverId)
        await message.reply(`Left voice channel \`${channelId}\`.`)
  }
})

// ---------------------------------------------------------------------------
// Video commands with Queue Support
// ---------------------------------------------------------------------------

function getVideoFiles() {
  try {
    const files = fs.readdirSync(VIDEO_DIR).filter(f => f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mkv') || f.endsWith('.avi'))
    return files
  } catch {
    return []
  }
}

async function playNextVideo(serverId, vc) {
  const queue = getQueue(serverId)
  if (queue.video.length === 0) {
    queue.currentVideo = null
    queue.videoPlayer = null
    return
  }

  const next = queue.video[0]
  queue.currentVideo = next

  try {
    await vc.playVideo(next.path, { type: next.type })
    queue.videoPlayer = vc._videoPlayer
  } catch (err) {
    console.error('[Wilmer] playNextVideo error:', err.message)
    queue.video.shift()
    playNextVideo(serverId, vc)
  }
}

bot.commands.add({
  name: 'playvideo',
  description: 'Play a video file in the voice channel',
  aliases: ['video', 'vid', 'pv'],
  usage: '!playvideo [screen|camera] <filename>',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      
      const serverId = message.serverId
      const queue = getQueue(serverId)
      const vc = bot.getVoiceConnection(serverId)
      
      if (!vc) return message.reply('I am not in a voice channel. Use `!joinvoice <channelId>` first.')
        
      let videoType = 'screen'
      let fileArg = args[0]
      
      if (args[0] === 'screen' || args[0] === 'camera') {
        videoType = args[0]
        fileArg = args[1]
      }
      
      if (!fileArg) {
        const files = getVideoFiles()
        return message.reply(`Usage: \`!playvideo [screen|camera] <filename>\`\nAvailable: ${files.join(', ') || 'none'}`)
      }
      
      const files = getVideoFiles()
      const match = files.find(f => f.toLowerCase().replace(/\.[^.]+$/, '') === fileArg.toLowerCase().replace(/\.[^.]+$/, ''))
      
      let filePath
      if (match) {
        filePath = `${VIDEO_DIR}/${match}`
      } else {
        const fuzzy = files.find(f => f.toLowerCase().includes(fileArg.toLowerCase()))
        if (fuzzy) {
          filePath = `${VIDEO_DIR}/${fuzzy}`
        } else {
          return message.reply(`Video file not found. Available: ${files.join(', ') || 'none'}`)
        }
      }

      const track = {
        path: filePath,
        name: filePath.split('/').pop(),
        type: videoType,
        requestedBy: message.username,
      }

      queue.video.push(track)

      if (!queue.currentVideo) {
        queue.currentVideo = track
        try {
          await vc.playVideo(track.path, { type: videoType })
          queue.videoPlayer = vc._videoPlayer
          await message.reply(`Now playing video: **${track.name}** (${videoType})`)
        } catch (err) {
          queue.video.shift()
          return message.reply(`Failed to play video: ${err.message}`)
        }
      } else {
        await message.reply(`Added to video queue: **${track.name}** (position ${queue.video.length})`)
      }
  }
})

bot.commands.add({
  name: 'stopvideo',
  description: 'Stop video playback',
  aliases: ['stopvid', 'sv'],
  execute: async (message) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      const queue = getQueue(message.serverId)
      const vc = bot.getVoiceConnection(message.serverId)
      
      if (!vc) return message.reply('I am not in a voice channel.')
      if (!queue.currentVideo) return message.reply('No video playing.')
        
        vc.stopVideo()
        queue.video = []
        queue.currentVideo = null
        queue.videoPlayer = null
        
        await message.reply('Video stopped and queue cleared.')
  }
})

bot.commands.add({
  name: 'skipvideo',
  description: 'Skip to the next video',
  aliases: ['svid', 'nextvideo'],
  execute: async (message) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      const queue = getQueue(message.serverId)
      const vc = bot.getVoiceConnection(message.serverId)
      
      if (!vc || !queue.currentVideo) return message.reply('No video playing.')
      
      vc.stopVideo()
      queue.video.shift()
      
      if (queue.video.length > 0) {
        await playNextVideo(message.serverId, vc)
        await message.reply(`Skipped. Now playing: **${queue.currentVideo.name}**`)
      } else {
        queue.currentVideo = null
        await message.reply('Skipped. Video queue empty.')
      }
  }
})

bot.commands.add({
  name: 'videolist',
  description: 'List available video files',
  aliases: ['videos', 'vfiles'],
  execute: async (message) => {
    const files = getVideoFiles()
    
    if (files.length === 0) {
      return message.reply('No video files found in ./video folder.')
    }
    
    const embed = new Embed()
      .setTitle('Available Video Files')
      .setDescription(files.map((f, i) => `${i + 1}. ${f}`).join('\n'))
      .setColor('#e74c3c')
      .setFooter(`${files.length} file(s)`)
    await message.reply({ content: '', embeds: [embed.toJSON()] })
  }
})

bot.commands.add({
  name: 'videoqueue',
  description: 'Show the video queue',
  aliases: ['vq', 'vqueue'],
  execute: async (message) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      const queue = getQueue(message.serverId)
      
      if (!queue.currentVideo && queue.video.length === 0) {
        return message.reply('Video queue is empty.')
      }

      let desc = ''
      if (queue.currentVideo) {
        desc += `**Now Playing:** ${queue.currentVideo.name} (${queue.currentVideo.type})\n\n`
      }

      if (queue.video.length > 0) {
        desc += '**Up Next:**\n'
        queue.video.slice(0, 10).forEach((t, i) => {
          desc += `${i + 1}. ${t.name} (${t.type}) - ${t.requestedBy}\n`
        })
        if (queue.video.length > 10) desc += `...and ${queue.video.length - 10} more`
      }

      const embed = new Embed()
        .setTitle('Video Queue')
        .setDescription(desc)
        .setColor('#e74c3c')
        .setFooter(`Total: ${queue.video.length} video(s)`)
      await message.reply({ content: '', embeds: [embed.toJSON()] })
  }
})

// ---------------------------------------------------------------------------
// Upload Commands - Audio/Video from URLs or Attachments
// ---------------------------------------------------------------------------

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http
    const file = fs.createWriteStream(destPath)
    
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        return downloadFile(response.headers.location, destPath)
          .then(resolve)
          .catch(reject)
      }
      
      if (response.statusCode !== 200) {
        return reject(new Error(`Failed to download: ${response.statusCode}`))
      }
      
      response.pipe(file)
      file.on('finish', () => {
        file.close()
        resolve()
      })
    }).on('error', (err) => {
      fs.unlink(destPath, () => {})
      reject(err)
    })
  })
}

const MAX_AUDIO_SIZE = 50 * 1024 * 1024
const MAX_VIDEO_SIZE = 200 * 1024 * 1024

bot.commands.add({
  name: 'uploadaudio',
  description: 'Upload audio from URL and optionally play it',
  aliases: ['ua', 'adduudio', 'audiofromurl'],
  usage: '!uploadaudio <url> [play]',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      if (!args[0]) return message.reply('Usage: `!uploadaudio <url> [play]`')

        const url = args[0]
        const shouldPlay = args.includes('play') || args.includes('p')
        
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          return message.reply('Please provide a valid URL starting with http:// or https://')
        }

        const ext = url.split('.').pop().split('?')[0].toLowerCase()
        const validAudio = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']
        
        if (!validAudio.includes(ext)) {
          return message.reply(`Invalid audio format. Supported: ${validAudio.join(', ')}`)
        }

        await message.reply(`Downloading audio from URL...`)

        const fileName = `url_${Date.now()}.${ext}`
        const filePath = `${AUDIO_DIR}/${fileName}`

        try {
          await downloadFile(url, filePath)
          const stats = fs.statSync(filePath)
          
          if (stats.size > MAX_AUDIO_SIZE) {
            fs.unlinkSync(filePath)
            return message.reply(`File too large (${Math.round(stats.size / 1024 / 1024)}MB). Max: ${MAX_AUDIO_SIZE / 1024 / 1024}MB`)
          }

          const queue = getQueue(message.serverId)
          let vc = bot.getVoiceConnection(message.serverId)
          
          const track = {
            path: filePath,
            name: fileName,
            url: url,
            requestedBy: message.username,
          }

          queue.audio.push(track)

          if (!queue.currentAudio) {
            queue.currentAudio = track
            if (!vc) {
              const channels = await bot.fetchChannels(message.serverId).catch(() => [])
              const voiceChannel = channels?.find(c => c.name?.toLowerCase().includes('general') || c.name?.toLowerCase().includes('voice'))
              if (voiceChannel) {
                vc = await bot.joinVoice(message.serverId, voiceChannel.id)
              }
            }
            if (vc) {
              try {
                await vc.playFile(track.path)
                await message.reply(`Downloaded and now playing: **${fileName}**`)
              } catch (err) {
                queue.audio.shift()
                return message.reply(`Downloaded but failed to play: ${err.message}`)
              }
            } else {
              await message.reply(`Downloaded: **${fileName}** (use !joinvoice first to play)`)
            }
          } else {
            await message.reply(`Downloaded: **${fileName}** added to queue (position ${queue.audio.length})`)
          }
        } catch (err) {
          await message.reply(`Failed to download: ${err.message}`)
        }
  }
})

bot.commands.add({
  name: 'uploadvideo',
  description: 'Upload video from URL and optionally play it',
  aliases: ['uv', 'addvideo', 'videofromurl'],
  usage: '!uploadvideo <url> [play] [screen|camera]',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      if (!args[0]) return message.reply('Usage: `!uploadvideo <url> [play] [screen|camera]`')

        const url = args[0]
        const shouldPlay = args.includes('play') || args.includes('p')
        const videoType = args.includes('camera') ? 'camera' : 'screen'
        
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          return message.reply('Please provide a valid URL starting with http:// or https://')
        }

        const ext = url.split('.').pop().split('?')[0].toLowerCase()
        const validVideo = ['mp4', 'webm', 'mkv', 'avi', 'mov']
        
        if (!validVideo.includes(ext)) {
          return message.reply(`Invalid video format. Supported: ${validVideo.join(', ')}`)
        }

        await message.reply(`Downloading video from URL...`)

        const fileName = `url_${Date.now()}.${ext}`
        const filePath = `${VIDEO_DIR}/${fileName}`

        try {
          await downloadFile(url, filePath)
          const stats = fs.statSync(filePath)
          
          if (stats.size > MAX_VIDEO_SIZE) {
            fs.unlinkSync(filePath)
            return message.reply(`File too large (${Math.round(stats.size / 1024 / 1024)}MB). Max: ${MAX_VIDEO_SIZE / 1024 / 1024}MB`)
          }

          const queue = getQueue(message.serverId)
          let vc = bot.getVoiceConnection(message.serverId)
          
          const track = {
            path: filePath,
            name: fileName,
            url: url,
            type: videoType,
            requestedBy: message.username,
          }

          queue.video.push(track)

          if (!queue.currentVideo) {
            queue.currentVideo = track
            if (!vc) {
              const channels = await bot.fetchChannels(message.serverId).catch(() => [])
              const voiceChannel = channels?.find(c => c.name?.toLowerCase().includes('general') || c.name?.toLowerCase().includes('voice'))
              if (voiceChannel) {
                vc = await bot.joinVoice(message.serverId, voiceChannel.id)
              }
            }
            if (vc) {
              try {
                await vc.playVideo(track.path, { type: videoType })
                await message.reply(`Downloaded and now playing video: **${fileName}** (${videoType})`)
              } catch (err) {
                queue.video.shift()
                return message.reply(`Downloaded but failed to play: ${err.message}`)
              }
            } else {
              await message.reply(`Downloaded: **${fileName}** (use !joinvoice first to play)`)
            }
          } else {
            await message.reply(`Downloaded: **${fileName}** added to video queue (position ${queue.video.length})`)
          }
        } catch (err) {
          await message.reply(`Failed to download: ${err.message}`)
        }
  }
})

bot.commands.add({
  name: 'stream',
  description: 'Stream audio/video from URL by downloading first',
  aliases: ['streamaudio', 'streamvideo', 'playurl'],
  usage: '!stream <url> [audio|video] [screen|camera]',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      if (!args[0]) return message.reply('Usage: `!stream <url> [audio|video] [screen|camera]`')

        const url = args[0]
        
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          return message.reply('Please provide a valid URL')
        }

        // Define valid extensions
        const validAudioExts = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']
        const validVideoExts = ['mp4', 'webm', 'mkv', 'avi', 'mov']
        
        // Extract file extension from URL
        let ext = url.split('.').pop().split('?')[0].toLowerCase()
        
        // Auto-detect type based on extension if not explicitly specified
        let typeArg = 'audio'
        if (args.includes('video')) {
          typeArg = 'video'
        } else if (args.includes('audio')) {
          typeArg = 'audio'
        } else if (validVideoExts.includes(ext)) {
          // Auto-detect video based on extension
          typeArg = 'video'
        }
        
        const videoType = args.includes('camera') ? 'camera' : 'screen'

        const queue = getQueue(message.serverId)
        let vc = bot.getVoiceConnection(message.serverId)

        if (!vc) {
          const channels = await bot.fetchChannels(message.serverId).catch(() => [])
          const voiceChannel = channels?.find(c => c.name?.toLowerCase().includes('general') || c.name?.toLowerCase().includes('voice'))
          if (!voiceChannel) return message.reply('No voice channel found. Use `!joinvoice` first.')
          vc = await bot.joinVoice(message.serverId, voiceChannel.id)
        }

        // Validate and normalize extension
        if (typeArg === 'audio') {
          if (!validAudioExts.includes(ext)) ext = 'mp3'
        } else {
          if (!validVideoExts.includes(ext)) ext = 'mp4'
        }

        const fileName = `stream_${Date.now()}.${ext}`
        const filePath = typeArg === 'audio' ? `${AUDIO_DIR}/${fileName}` : `${VIDEO_DIR}/${fileName}`

        await message.reply(`Downloading ${typeArg} stream from URL...`)

        try {
          await downloadFile(url, filePath)
          const stats = fs.statSync(filePath)
          
          const maxSize = typeArg === 'audio' ? MAX_AUDIO_SIZE : MAX_VIDEO_SIZE
          if (stats.size > maxSize) {
            fs.unlinkSync(filePath)
            return message.reply(`File too large (${Math.round(stats.size / 1024 / 1024)}MB). Max: ${maxSize / 1024 / 1024}MB`)
          }

          if (typeArg === 'audio') {
            const track = {
              path: filePath,
              name: fileName,
              url: url,
              requestedBy: message.username,
              isStream: true,
            }

            queue.audio.push(track)

            if (!queue.currentAudio) {
              queue.currentAudio = track
              try {
                await vc.playFile(filePath)
                await message.reply(`Now playing audio: **${fileName}**`)
              } catch (err) {
                queue.audio.shift()
                fs.unlinkSync(filePath)
                return message.reply(`Failed to play: ${err.message}`)
              }
            } else {
              await message.reply(`Queued audio: **${fileName}** (position ${queue.audio.length})`)
            }
          } else {
            const track = {
              path: filePath,
              name: fileName,
              url: url,
              type: videoType,
              requestedBy: message.username,
              isStream: true,
            }

            queue.video.push(track)

            if (!queue.currentVideo) {
              queue.currentVideo = track
              try {
                await vc.playVideo(filePath, { type: videoType })
                await message.reply(`Now playing video: **${fileName}** (${videoType})`)
              } catch (err) {
                queue.video.shift()
                fs.unlinkSync(filePath)
                return message.reply(`Failed to play video: ${err.message}`)
              }
            } else {
              await message.reply(`Queued video: **${fileName}** (position ${queue.video.length})`)
            }
          }
        } catch (err) {
          await message.reply(`Failed to download: ${err.message}`)
        }
  }
})

bot.commands.add({
  name: 'saveaudio',
  description: 'Save attached audio file to server',
  aliases: ['sa', 'savea'],
  usage: '!saveaudio [name]',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      
        const attachment = message.attachments?.[0]
        if (!attachment) return message.reply('Please attach an audio file to upload.')

        const url = attachment.url
        const ext = attachment.filename?.split('.').pop()?.toLowerCase() || 'mp3'
        const validAudio = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']
        
        if (!validAudio.includes(ext)) {
          return message.reply(`Invalid audio format. Supported: ${validAudio.join(', ')}`)
        }

        const name = args[0]?.replace(/[^a-zA-Z0-9._-]/g, '_') || `upload_${Date.now()}`
        const fileName = `${name}.${ext}`
        const filePath = `${AUDIO_DIR}/${fileName}`

        await message.reply(`Downloading audio...`)

        try {
          await downloadFile(url, filePath)
          const stats = fs.statSync(filePath)
          
          if (stats.size > MAX_AUDIO_SIZE) {
            fs.unlinkSync(filePath)
            return message.reply(`File too large (${Math.round(stats.size / 1024 / 1024)}MB). Max: ${MAX_AUDIO_SIZE / 1024 / 1024}MB`)
          }

          await message.reply(`Saved audio: **${fileName}** (${Math.round(stats.size / 1024 / 1024 * 10) / 10}MB)`)
        } catch (err) {
          await message.reply(`Failed to save: ${err.message}`)
        }
  }
})

bot.commands.add({
  name: 'savevideo',
  description: 'Save attached video file to server',
  aliases: ['sv', 'savev'],
  usage: '!savevideo [name]',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      
        const attachment = message.attachments?.[0]
        if (!attachment) return message.reply('Please attach a video file to upload.')

        const url = attachment.url
        const ext = attachment.filename?.split('.').pop()?.toLowerCase() || 'mp4'
        const validVideo = ['mp4', 'webm', 'mkv', 'avi', 'mov']
        
        if (!validVideo.includes(ext)) {
          return message.reply(`Invalid video format. Supported: ${validVideo.join(', ')}`)
        }

        const name = args[0]?.replace(/[^a-zA-Z0-9._-]/g, '_') || `upload_${Date.now()}`
        const fileName = `${name}.${ext}`
        const filePath = `${VIDEO_DIR}/${fileName}`

        await message.reply(`Downloading video...`)

        try {
          await downloadFile(url, filePath)
          const stats = fs.statSync(filePath)
          
          if (stats.size > MAX_VIDEO_SIZE) {
            fs.unlinkSync(filePath)
            return message.reply(`File too large (${Math.round(stats.size / 1024 / 1024)}MB). Max: ${MAX_VIDEO_SIZE / 1024 / 1024}MB`)
          }

          await message.reply(`Saved video: **${fileName}** (${Math.round(stats.size / 1024 / 1024 * 10) / 10}MB)`)
        } catch (err) {
          await message.reply(`Failed to save: ${err.message}`)
        }
  }
})

bot.commands.add({
  name: 'playattachment',
  description: 'Play attached audio/video file directly',
  aliases: ['pa', 'playatt', 'playattach'],
  usage: '!playattachment [audio|video] [screen|camera]',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      
        const attachment = message.attachments?.[0]
        if (!attachment) return message.reply('Please attach a file to play.')

        const url = attachment.url
        const filename = attachment.filename || ''
        const ext = filename.split('.').pop()?.toLowerCase() || ''
        
        const isVideo = args.includes('video') || ['mp4', 'webm', 'mkv', 'avi', 'mov'].includes(ext)
        const videoType = args.includes('camera') ? 'camera' : 'screen'

        const queue = getQueue(message.serverId)
        let vc = bot.getVoiceConnection(message.serverId)

        if (!vc) {
          const channels = await bot.fetchChannels(message.serverId).catch(() => [])
          const voiceChannel = channels?.find(c => c.name?.toLowerCase().includes('general') || c.name?.toLowerCase().includes('voice'))
          if (!voiceChannel) return message.reply('No voice channel found. Use `!joinvoice` first.')
          vc = await bot.joinVoice(message.serverId, voiceChannel.id)
        }

        const name = `attach_${Date.now()}.${ext}`
        
        if (isVideo) {
          const filePath = `${VIDEO_DIR}/${name}`
          await message.reply(`Downloading and playing video...`)
          
          try {
            await downloadFile(url, filePath)
            await vc.playVideo(filePath, { type: videoType })
            await message.reply(`Now playing video: **${filename}**`)
          } catch (err) {
            await message.reply(`Failed to play: ${err.message}`)
          }
        } else {
          const filePath = `${AUDIO_DIR}/${name}`
          await message.reply(`Downloading and playing audio...`)
          
          try {
            await downloadFile(url, filePath)
            await vc.playFile(filePath)
            await message.reply(`Now playing audio: **${filename}**`)
          } catch (err) {
            await message.reply(`Failed to play: ${err.message}`)
          }
        }
  }
})

bot.commands.add({
  name: 'mediainfo',
  description: 'Show media storage info',
  aliases: ['mi', 'storage', 'diskinfo'],
  execute: async (message) => {
    const audioFiles = getAudioFiles()
    const videoFiles = getVideoFiles()
    
    let audioSize = 0
    let videoSize = 0
    
    try {
      audioSize = audioFiles.reduce((acc, f) => acc + fs.statSync(`${AUDIO_DIR}/${f}`).size, 0)
      videoSize = videoFiles.reduce((acc, f) => acc + fs.statSync(`${VIDEO_DIR}/${f}`).size, 0)
    } catch {}

    const embed = new Embed()
      .setTitle('Media Storage Info')
      .setColor('#5865f2')
      .addField('Audio Files', `${audioFiles.length} files (${Math.round(audioSize / 1024 / 1024 * 10) / 10} MB)`, true)
      .addField('Video Files', `${videoFiles.length} files (${Math.round(videoSize / 1024 / 1024 * 10) / 10} MB)`, true)
      .addField('Max Audio Size', `${MAX_AUDIO_SIZE / 1024 / 1024} MB`, true)
      .addField('Max Video Size', `${MAX_VIDEO_SIZE / 1024 / 1024} MB`, true)
      .setFooter(`Total: ${Math.round((audioSize + videoSize) / 1024 / 1024 * 10) / 10} MB`)
    
    await message.reply({ content: '', embeds: [embed.toJSON()] })
  }
})

bot.commands.add({
  name: 'deletemedia',
  description: 'Delete an audio or video file from server',
  aliases: ['dm', 'delmedia', 'rmmedia'],
  usage: '!deletemedia <audio|video> <filename>',
  execute: async (message, args) => {
    if (!message.serverId) return message.reply('This command only works in a server.')
      if (args.length < 2) return message.reply('Usage: `!deletemedia <audio|video> <filename>`')

        const type = args[0].toLowerCase()
        const name = args.slice(1).join(' ')
        
        if (type === 'audio' || type === 'a') {
          const files = getAudioFiles()
          const file = files.find(f => f === name || f.toLowerCase() === name.toLowerCase())
          
          if (!file) return message.reply(`Audio file not found: ${name}`)
          
          const filePath = `${AUDIO_DIR}/${file}`
          fs.unlinkSync(filePath)
          await message.reply(`Deleted audio: **${file}**`)
        } else if (type === 'video' || type === 'v') {
          const files = getVideoFiles()
          const file = files.find(f => f === name || f.toLowerCase() === name.toLowerCase())
          
          if (!file) return message.reply(`Video file not found: ${name}`)
          
          const filePath = `${VIDEO_DIR}/${file}`
          fs.unlinkSync(filePath)
          await message.reply(`Deleted video: **${file}**`)
        } else {
          await message.reply('Usage: `!deletemedia <audio|video> <filename>`')
        }
  }
})

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

bot.on('ready', async (info) => {
  console.log(`[Wilmer] Online as ${info.name} (${info.id || info.botId})`)
  console.log(`[Wilmer] Serving ${info.servers?.length || 0} servers`)
  console.log(`[Wilmer] ${bot.commands.toArray().length} commands registered`)

  // Pre-populate the channel cache for all servers so commands like
  // !channels, !joinvoice etc. can resolve channel names without an extra
  // fetch round-trip.
  const serverList = info.servers || []
  for (const serverId of serverList) {
    try {
      const channels = await bot.fetchChannels(serverId)
      console.log(`[Wilmer] Cached ${channels?.length || 0} channels for server ${serverId}`)
    } catch (err) {
      console.warn(`[Wilmer] Could not pre-fetch channels for server ${serverId}: ${err.message}`)
    }
  }
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
  console.log(`[Wilmer] Voice leave event: userId=${data.userId}, channelId=${data.channelId}, serverId=${data.serverId}`)
  console.log(`[Wilmer] Bot ID: ${bot.bot?.id}`)
  
  // Only leave if it's EXPLICITLY the bot being kicked/removed
  // Don't auto-leave if it's just another user leaving
  if (data.userId === bot.bot?.id && data.serverId) {
    const vc = bot.getVoiceConnection(data.serverId)
    if (vc) {
      console.log(`[Wilmer] Bot was removed from voice channel ${vc.channelId} externally - cleaning up`)
      bot.leaveVoice(data.serverId)
    }
  }
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
