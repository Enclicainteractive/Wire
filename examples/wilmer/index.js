import { Client, Embed } from '@voltchat/wire'

// --- Configuration ---
const BOT_TOKEN = process.env.WILMER_TOKEN || 'vbot_your_token_here'
const SERVER_URL = process.env.VOLT_SERVER || 'http://localhost:5000'

const bot = new Client({
  prefix: '!',
  debug: true
})

// --- Commands ---

bot.commands.add({
  name: 'ping',
  description: 'Check bot latency',
  execute: async (message) => {
    const start = Date.now()
    const reply = await message.reply('Pinging...')
    await message.reply(`Pong! Roundtrip: **${Date.now() - start}ms** | Uptime: **${formatUptime(bot.uptime)}**`)
  }
})

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
      `What's up, **${name}**? I'm Wilmer, your friendly neighborhood bot!`
    ]
    await message.reply(greetings[Math.floor(Math.random() * greetings.length)])
  }
})

bot.commands.add({
  name: 'help',
  description: 'Show available commands',
  execute: async (message) => {
    const cmds = bot.commands.toArray()
    const list = cmds.map(c => `\`!${c.name}\` - ${c.description}`).join('\n')
    const embed = new Embed()
      .setTitle('Wilmer Commands')
      .setDescription(list)
      .setColor('#f5c542')
      .setFooter('Built with @voltchat/wire')
      .setTimestamp()
    await message.reply({ content: '', embeds: [embed.toJSON()] })
  }
})

bot.commands.add({
  name: 'roll',
  description: 'Roll dice (e.g. !roll 2d6)',
  usage: '!roll [NdS]',
  execute: async (message, args) => {
    const spec = args[0] || '1d6'
    const match = spec.match(/^(\d+)?d(\d+)$/i)
    if (!match) {
      await message.reply('Usage: `!roll NdS` (e.g. `!roll 2d20`)')
      return
    }
    const count = Math.min(parseInt(match[1] || '1'), 100)
    const sides = Math.min(parseInt(match[2]), 1000)
    const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1)
    const total = rolls.reduce((a, b) => a + b, 0)
    await message.reply(`**${spec}** => [ ${rolls.join(', ')} ] = **${total}**`)
  }
})

bot.commands.add({
  name: '8ball',
  description: 'Ask the magic 8-ball a question',
  aliases: ['ask'],
  execute: async (message, args) => {
    if (!args.length) {
      await message.reply('You need to ask a question! `!8ball Will it rain today?`')
      return
    }
    const answers = [
      'It is certain.', 'Without a doubt.', 'Yes, definitely.',
      'You may rely on it.', 'As I see it, yes.', 'Most likely.',
      'Outlook good.', 'Yes.', 'Signs point to yes.',
      'Reply hazy, try again.', 'Ask again later.', 'Better not tell you now.',
      'Cannot predict now.', 'Concentrate and ask again.',
      "Don't count on it.", 'My reply is no.', 'My sources say no.',
      'Outlook not so good.', 'Very doubtful.'
    ]
    const answer = answers[Math.floor(Math.random() * answers.length)]
    await message.reply(`**Q:** ${args.join(' ')}\n**A:** ${answer}`)
  }
})

bot.commands.add({
  name: 'coinflip',
  description: 'Flip a coin',
  aliases: ['flip', 'coin'],
  execute: async (message) => {
    const result = Math.random() < 0.5 ? 'Heads' : 'Tails'
    await message.reply(`The coin lands on... **${result}**!`)
  }
})

bot.commands.add({
  name: 'serverinfo',
  description: 'Show info about the bot',
  aliases: ['info', 'about'],
  execute: async (message) => {
    const embed = new Embed()
      .setTitle('About Wilmer')
      .setDescription('Wilmer is an example bot built with **@voltchat/wire**, the official VoltChat bot framework.')
      .setColor('#5865f2')
      .addField('Library', '@voltchat/wire v1.0.0', true)
      .addField('Uptime', formatUptime(bot.uptime), true)
      .addField('Servers', String(bot.bot?.servers?.length || 0), true)
      .addField('Commands', String(bot.commands.toArray().length), true)
      .setFooter('github.com/voltchat/wire')
      .setTimestamp()
    await message.reply({ content: '', embeds: [embed.toJSON()] })
  }
})

bot.commands.add({
  name: 'echo',
  description: 'Repeat your message',
  cooldown: 5,
  execute: async (message, args) => {
    if (!args.length) {
      await message.reply('Usage: `!echo <text>`')
      return
    }
    await message.reply(args.join(' '))
  }
})

// --- Error handler ---
bot.commands.onError(async (err, message, cmd) => {
  console.error(`[Wilmer] Error in ${cmd.name}:`, err)
  await message.reply(`Something went wrong running \`!${cmd.name}\`. Please try again later.`)
})

// --- Events ---

bot.on('ready', (info) => {
  console.log(`[Wilmer] Online as ${info.name}`)
  console.log(`[Wilmer] Serving ${info.servers?.length || 0} servers`)
  console.log(`[Wilmer] ${bot.commands.toArray().length} commands registered`)
})

bot.on('memberJoin', (data) => {
  console.log(`[Wilmer] Member joined: ${data.username} in server ${data.serverId}`)
})

bot.on('error', (err) => {
  console.error('[Wilmer] Error:', err.message)
})

bot.on('disconnect', (reason) => {
  console.log('[Wilmer] Disconnected:', reason)
})

// --- Helpers ---

function formatUptime(ms) {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h`
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

// --- Start ---
bot.login(BOT_TOKEN, SERVER_URL).catch(err => {
  console.error('[Wilmer] Failed to start:', err.message)
  process.exit(1)
})
