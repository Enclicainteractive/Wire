# @voltchat/wire

The official bot framework for VoltChat. Build bots that respond to messages, run commands, moderate servers, stream audio into voice channels, and react to every platform event.

## Install

```bash
npm install @voltchat/wire
```

Requires Node.js ≥ 18. Pure ES modules (`"type": "module"`).

## Quick Start

```js
import { Client, BotStatus } from '@voltchat/wire'

const bot = new Client({ prefix: '!' })

bot.commands.add({
  name: 'ping',
  description: 'Check latency',
  execute: async (message) => {
    await message.reply(`Pong! Uptime: ${bot.uptime}ms`)
  }
})

bot.on('ready', async (info) => {
  console.log(`${info.name} is online in ${info.servers.length} servers`)
  await bot.setStatus(BotStatus.ONLINE, 'Ready to help!')
})

bot.login('vbot_your_token', 'https://your-volt-server.com')
```

See [`examples/wilmer/`](examples/wilmer/) for a complete, production-style example bot.

---

## API Reference

### `Client`

The main bot client. Connects to the VoltChat gateway via WebSocket and exposes the full API.

```js
const bot = new Client({
  prefix: '!',          // Command prefix (default: '!')
  debug: true,          // Enable [Wire] console logs
  reconnect: true,      // Auto-reconnect on disconnect (default: true)
  reconnectDelay: 5000, // Delay between reconnect attempts in ms
  userToken: null,      // Override the socket auth token (advanced)
  serverUrl: null,      // Can be set here instead of login()
})

await bot.login(token, serverUrl)
```

#### Properties

| Property | Type | Description |
|---|---|---|
| `bot` | `object` | Bot profile (id, name, servers, permissions) |
| `commands` | `CommandRegistry` | Registered command handler |
| `servers` | `Map` | Cache of server data, keyed by server ID |
| `channels` | `Map` | Cache of channel data, keyed by channel ID |
| `members` | `Map` | Cache of member data, keyed by `serverId:userId` |
| `uptime` | `number` | Milliseconds since the bot became ready |
| `isReady` | `boolean` | Whether the socket is connected and ready |

#### Methods

```js
// Send a message
await bot.send(channelId, 'Hello!', { embeds: [...] })

// Status — 'online' | 'idle' | 'dnd' | 'offline'
// Instantly broadcasts over the WebSocket AND persists via REST.
// customStatus appears under the bot's name in the members sidebar.
await bot.setStatus('idle')
await bot.setStatus('dnd',    'Do not disturb')
await bot.setStatus('online', 'Listening to music 🎵')
await bot.setStatus('offline')          // clears customStatus too

// Typing indicator
await bot.startTyping(channelId)             // one-shot
await bot.startTyping(channelId, true)       // continuous until stopTyping()
bot.stopTyping(channelId)

// Fetch & cache server data
const members  = await bot.fetchMembers(serverId)
const channels = await bot.fetchChannels(serverId)
const server   = await bot.fetchServer(serverId)

// Voice (requires @roamhq/wrtc)
const vc = await bot.joinVoice(serverId, channelId)
await vc.playFile('./audio.mp3')
await bot.leaveVoice(serverId)
const vc = bot.getVoiceConnection(serverId)  // undefined if not in voice

// Graceful shutdown
bot.destroy()
```

#### Events

```js
bot.on('ready',          (botInfo) => {})
bot.on('message',        (message) => {})   // Message object
bot.on('messageEdit',    (message) => {})
bot.on('messageDelete',  (data)    => {})
bot.on('messagePinned',  (data)    => {})
bot.on('messageUnpinned',(data)    => {})
bot.on('reaction',       (data)    => {})   // all reaction events
bot.on('reactionAdd',    (data)    => {})
bot.on('reactionRemove', (data)    => {})
bot.on('memberJoin',     (data)    => {})
bot.on('memberLeave',    (data)    => {})
bot.on('memberOffline',  (data)    => {})
bot.on('channelCreate',  (data)    => {})
bot.on('channelUpdate',  (data)    => {})
bot.on('channelDelete',  (data)    => {})
bot.on('serverUpdate',   (data)    => {})
bot.on('typingStart',    (data)    => {})
bot.on('voiceJoin',      (data)    => {})   // { userId, channelId, … }
bot.on('voiceLeave',     (data)    => {})
bot.on('voiceUpdate',    (data)    => {})
bot.on('userStatus',     (data)    => {})   // { userId, status, customStatus, isBot }
bot.on('peerJoin',       (userId)  => {})  // VoiceConnection event (see Voice)
bot.on('peerLeave',      (userId)  => {})
bot.on('ui:interaction', (data)    => {})  // Bot UI interaction event
bot.on('ui:buttonClick', (data)    => {})  // Button clicked
bot.on('ui:inputSubmit', (data)    => {})  // Input submitted
bot.on('ui:selectChange',(data)    => {})  // Select changed
bot.on('ui:canvasClick',(data)    => {})  // Canvas pixel clicked
bot.on('disconnect',     (reason)  => {})
bot.on('reconnect',      ()        => {})
bot.on('error',          (err)     => {})
```

---

### `Message`

Received from `message` and `messageEdit` events. Wraps the raw data and provides action methods.

```js
bot.on('message', async (message) => {
  message.id          // string
  message.channelId   // string
  message.serverId    // string | null
  message.userId      // string
  message.username    // string
  message.content     // string
  message.embeds      // array
  message.attachments // array
  message.bot         // boolean
  message.pinned      // boolean
  message.replyTo     // string | null
  message.timestamp   // Date
  message.author      // { id, username, avatar, bot }
  message.age         // ms since sent
  message.inServer    // boolean
  message.hasEmbeds   // boolean
  message.hasAttachments // boolean

  // Actions
  await message.reply('text')
  await message.reply({ content: 'text', embeds: [...] })
  await message.edit('new content')
  await message.delete()
  await message.pin()
  await message.unpin()
  await message.react('👋')
  await message.unreact('👋')
  await message.startTyping()

  // Helpers
  message.parseCommand('!')  // → { name, args, raw } | null
  message.mentions(userId)   // boolean
})
```

---

### `CommandRegistry`

```js
bot.commands.add({
  name: 'ban',
  description: 'Ban a user',
  usage: '!ban <userId> [reason]',
  aliases: ['b'],
  cooldown: 10,         // seconds per user
  permissions: ['admin'],
  execute: async (message, args, ctx) => {
    // ctx = { command, prefix, raw }
    await message.reply(`Banning ${args[0]}`)
  }
})

// Remove a command
bot.commands.remove('ban')

// Global command error handler
bot.commands.onError(async (err, message, cmd) => {
  await message.reply(`Error in !${cmd.name}: ${err.message}`)
})

// Array of { name, description, usage } for display / API sync
bot.commands.toArray()
```

---

### Voice

Stream audio into VoltChat voice channels using WebRTC. Requires the native `@roamhq/wrtc` package.

```bash
npm install @roamhq/wrtc
```

Also requires `ffmpeg` to be installed and available on `PATH` (used to decode audio files to raw PCM).

#### Joining and playing audio

```js
bot.on('ready', async () => {
  const vc = await bot.joinVoice(serverId, channelId)

  // playFile() buffers the decoded PCM immediately but holds the pump
  // until a WebRTC peer connection is established — so audio is never
  // silently discarded during the ICE negotiation window.
  await vc.playFile('./audio.mp3')

  vc.on('finish', () => console.log('Done playing'))
  vc.on('error',  (err) => console.error('Voice error:', err.message))
})
```

#### `VoiceConnection` API

```js
const vc = await bot.joinVoice(serverId, channelId)
// or
const vc = bot.getVoiceConnection(serverId)   // undefined if not connected

await vc.playFile(filePath)             // play any file ffmpeg can decode
await vc.playFile(filePath, { loop: true }) // loop until stopAudio()
vc.stopAudio()                          // stop without leaving the channel
await bot.leaveVoice(serverId)          // leave + clean up all peers

vc.channelId   // string
vc.serverId    // string
vc.connected   // boolean
vc.peerCount   // number of active WebRTC peer connections
```

#### `VoiceConnection` events

```js
vc.on('ready',     ()       => {})  // joined the channel
vc.on('peerJoin',  (userId) => {})  // new user entered the channel
vc.on('peerLeave', (userId) => {})  // user left the channel
vc.on('finish',    ()       => {})  // audio file finished (non-looping)
vc.on('error',     (err)    => {})  // WebRTC or audio error
```

#### Full example — `!joinvoice` command

```js
import { Client, BotStatus } from '@voltchat/wire'

const bot = new Client({ prefix: '!' })

bot.commands.add({
  name: 'joinvoice',
  aliases: ['jv'],
  usage: '!joinvoice <channelId>',
  execute: async (message, args) => {
    if (!args[0]) return message.reply('Usage: `!joinvoice <channelId>`')

    const vc = await bot.joinVoice(message.serverId, args[0])

    vc.on('finish', () => console.log('Audio finished'))
    vc.on('error',  (e) => console.error('Voice error:', e.message))

    await message.reply(`Joined \`${args[0]}\`. Playing audio…`)
    await vc.playFile('./audio.mp3')
  }
})

bot.commands.add({
  name: 'leavevoice',
  aliases: ['lv'],
  execute: async (message) => {
    await bot.leaveVoice(message.serverId)
    await message.reply('Left voice channel.')
  }
})

bot.login(process.env.BOT_TOKEN, process.env.VOLT_SERVER)
```

---

### Bot Status & Custom Status

Bots support the same status system as human users. The status and custom status text are shown in the members sidebar in real time.

```js
import { BotStatus } from '@voltchat/wire'

// Set status on ready
bot.on('ready', async () => {
  await bot.setStatus(BotStatus.ONLINE, 'Ready to help!')
})

// Change during operation
await bot.setStatus(BotStatus.IDLE, 'Taking a break')
await bot.setStatus(BotStatus.DND,  'Processing…')
await bot.setStatus(BotStatus.ONLINE)          // clears customStatus
await bot.setStatus(BotStatus.OFFLINE)         // bot appears offline

// Via RestClient directly (REST-only, no instant socket push)
await bot.rest.setStatus('idle', 'Taking a break')
```

`setStatus()` does two things simultaneously:
1. Emits `bot:status-change` over the open WebSocket — the sidebar updates within milliseconds.
2. Persists via `PUT /api/bots/api/status` — the status survives reconnects.

#### Custom status notes

- `customStatus` is a short string (≤ 128 chars recommended) shown under the bot's name.
- Passing `null` or omitting it clears any existing custom status.
- The status and custom status survive bot restarts (persisted in `bots.json`).

---

### `RestClient`

Direct HTTP access to every bot API endpoint. Available as `bot.rest` or standalone.

```js
import { RestClient } from '@voltchat/wire'
const rest = new RestClient('https://your-server.com', 'vbot_token')
```

#### Bot identity
```js
await rest.getMe()
await rest.getGateway()
```

#### Messages
```js
await rest.sendMessage(channelId, 'Hello!')
await rest.sendMessage(channelId, { content: 'Hi', embeds: [...] })
await rest.editMessage(channelId, messageId, 'Edited content')
await rest.deleteMessage(channelId, messageId)
await rest.pinMessage(channelId, messageId)
await rest.unpinMessage(channelId, messageId)
```

#### Reactions
```js
await rest.addReaction(channelId, messageId, '👍')
await rest.removeReaction(channelId, messageId, '👍')
```

#### Channels
```js
await rest.getChannels(serverId)
await rest.getChannel(channelId)
await rest.sendTyping(channelId)
```

#### Servers & members
```js
await rest.getServer(serverId)
await rest.getServerMembers(serverId)
await rest.getServerMember(serverId, userId)
await rest.kickMember(serverId, userId, 'reason')
await rest.banMember(serverId, userId, 'reason')
await rest.unbanMember(serverId, userId)
await rest.getBans(serverId)
await rest.getRoles(serverId)
await rest.addRole(serverId, userId, roleId)
await rest.removeRole(serverId, userId, roleId)
```

#### Commands & status
```js
await rest.registerCommands([{ name, description, usage }])
await rest.setStatus('online')
await rest.setStatus('idle', 'Taking a break')   // with customStatus
await rest.setStatus('online', null)              // clear customStatus
```

---

### `Embed`

Fluent builder for rich embeds.

```js
import { Embed } from '@voltchat/wire'

const embed = new Embed()
  .setTitle('Server Stats')
  .setDescription('Current snapshot')
  .setColor('#5865f2')
  .setURL('https://example.com')
  .setAuthor('Wilmer', avatarUrl)
  .setThumbnail(iconUrl)
  .setImage(bannerUrl)
  .addField('Members', '42', true)
  .addField('Channels', '8', true)
  .setFooter('Powered by Wire')
  .setTimestamp()

await bot.send(channelId, '', { embeds: [embed.toJSON()] })
```

---

### Bot UI Toolkit

Wire includes a powerful UI toolkit for creating interactive messages with buttons, inputs, selects, canvas drawings, and more. These interactive messages allow bots to create rich user experiences with polls, forms, games, and more.

```js
import { 
  InteractiveMessage,
  BotButton, 
  BotInput, 
  BotSelect, 
  BotCanvas,
  BotText,
  BotImage,
  BotDivider,
  BotSpacer,
  BotActionRow
} from '@voltchat/wire'
```

#### Interactive Messages

Create interactive messages with UI components:

```js
// Create an interactive message
const msg = bot.createInteractiveMessage()
msg.setContent('Choose an option:')

// Add buttons
const row = msg.addActionRow()
row.addButton({
  label: 'Yes',
  emoji: '✅',
  variant: 'success',
  action: 'confirm'
})
row.addButton({
  label: 'No',
  emoji: '❌',
  variant: 'danger',
  action: 'deny'
})

// Send the interactive message
await bot.sendUI(channelId, msg)
```

#### Buttons

```js
const button = bot.createButton({
  label: 'Click Me',
  emoji: '👋',
  variant: 'primary', // primary, secondary, danger, success, link
  action: 'my_action',
  confirm: 'Are you sure?'
})
```

#### Input Fields

```js
const input = bot.createInput({
  label: 'Your Name',
  placeholder: 'Enter your name...',
  required: true,
  minLength: 2,
  maxLength: 50,
  action: 'submit_name'
})
```

#### Select/Dropdown

```js
const select = bot.createSelect({
  placeholder: 'Choose a color',
  multiple: false
})
select.addOption('red', 'Red', '🔴')
select.addOption('blue', 'Blue', '🔵')
select.addOption('green', 'Green', '🟢')
```

#### Canvas (Pixel Drawing)

```js
const canvas = bot.createCanvas({
  width: 100,
  height: 100,
  interactive: true, // Allow users to click and draw
  action: 'pixel_click'
})

// Pre-draw some pixels
canvas.setPixel(50, 50, '#ff0000')
canvas.setPixel(51, 50, '#00ff00')
canvas.setPixel(50, 51, '#0000ff')
```

#### Complete Example

```js
// Create a poll
const poll = bot.createInteractiveMessage()
poll.setContent('What is your favorite programming language?')

const row = poll.addActionRow()
row.addButton({ label: 'JavaScript', emoji: '📜', variant: 'primary', action: 'vote_js' })
row.addButton({ label: 'Python', emoji: '🐍', variant: 'primary', action: 'vote_py' })
row.addButton({ label: 'Rust', emoji: '🦀', variant: 'primary', action: 'vote_rust' })

const pollMsg = await bot.sendUI(channelId, poll)

// Listen for button clicks
bot.on('ui:buttonClick', async (data) => {
  if (data.action === 'vote_js') {
    await bot.send(channelId, 'You voted for JavaScript!')
  }
})
```

#### Convenience Methods

```js
// Quick button message
await bot.sendButtons(channelId, 'Pick one:', [
  { label: 'Option A', action: 'a' },
  { label: 'Option B', action: 'b' }
])

// Quick canvas message
const canvas = bot.createCanvas({ width: 50, height: 50, interactive: true })
canvas.setPixel(25, 25, '#ffffff')
await bot.sendCanvas(channelId, 'Draw something!', canvas)

// Quick form
await bot.sendForm(channelId, 'Enter your feedback:', [
  { label: 'Feedback', placeholder: 'Your feedback...', required: true }
])
```

#### Listening for Interactions

```js
// Listen for any UI interaction
bot.on('ui:interaction', (data) => {
  console.log('Interaction:', data.componentId, data.action, data.value, data.userId)
})

// Listen for specific interactions
bot.on('ui:buttonClick', (data) => {
  console.log('Button clicked:', data.label, data.action)
})

bot.on('ui:inputSubmit', (data) => {
  console.log('Input submitted:', data.componentId, data.value)
})

bot.on('ui:selectChange', (data) => {
  console.log('Select changed:', data.componentId, data.value)
})

bot.on('ui:canvasClick', (data) => {
  console.log('Canvas clicked:', data.componentId, data.x, data.y)
})

// Wait for a specific interaction
const result = await bot.awaitUIInteraction(messageId, componentId, 30000)
```

---

### `Collection`

A `Map` subclass with Array-like helpers. Used for `bot.servers`, `bot.channels`, `bot.members`.

```js
import { Collection } from '@voltchat/wire'

const c = new Collection()
c.set('a', { id: 'a', name: 'general' })

c.find(v => v.name === 'general')
c.filter(v => v.name.startsWith('bot'))
c.map(v => v.name)
c.some(v => v.id === 'a')
c.every(v => v.id !== null)
c.reduce((acc, v) => acc + 1, 0)
c.toArray()
c.first()
c.last()
c.random()
```

---

### `WebhookServer`

Receive events via HTTP instead of WebSocket.

```js
import { WebhookServer } from '@voltchat/wire'

const server = new WebhookServer({
  port: 3100,
  secret: 'your_webhook_secret',
  path: '/webhook'
})

server.on('MESSAGE_CREATE', (data) => {
  console.log('New message:', data.content)
})

// Wildcard — all events
server.on('*', (eventName, data) => {
  console.log(eventName, data)
})

await server.start()
```

---

### Constants

```js
import { GatewayEvents, Intents, Permissions, BotStatus } from '@voltchat/wire'

BotStatus.ONLINE    // 'online'
BotStatus.IDLE      // 'idle'
BotStatus.DND       // 'dnd'
BotStatus.OFFLINE   // 'offline'

Permissions.MESSAGES_SEND   // 'messages:send'
Permissions.MEMBERS_MANAGE  // 'members:manage'
// …etc

GatewayEvents.MESSAGE_CREATE   // 'message:new'
GatewayEvents.MEMBER_JOIN      // 'member:joined'
GatewayEvents.USER_STATUS      // 'user:status'
GatewayEvents.BOT_STATUS_CHANGE// 'bot:status-change'
GatewayEvents.VOICE_JOIN       // 'voice:user-joined'
// …etc
```

---

## License

MIT — [github.com/Enclicainteractive/Wire](https://github.com/Enclicainteractive/Wire)
