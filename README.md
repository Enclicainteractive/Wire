# @voltchat/wire

The official bot framework for VoltChat. Build bots that respond to messages, run commands, and automate your servers.

## Install

```bash
npm install @voltchat/wire
```

## Quick Start

```javascript
import { Client } from '@voltchat/wire'

const bot = new Client({ prefix: '!' })

bot.commands.add({
  name: 'ping',
  description: 'Check bot latency',
  execute: async (message) => {
    await message.reply(`Pong! ${bot.uptime}ms uptime`)
  }
})

bot.commands.add({
  name: 'hello',
  description: 'Say hello',
  execute: async (message, args) => {
    const name = args[0] || message.username
    await message.reply(`Hello, ${name}!`)
  }
})

bot.on('ready', (info) => {
  console.log(`${info.name} is online in ${info.servers.length} servers`)
})

bot.login('vbot_your_token_here', 'https://your-volt-server.com')
```

## Features

- **WebSocket client** with auto-reconnect and server room joining
- **Command registry** with prefix parsing, aliases, cooldowns, and error handling
- **REST client** for sending messages, managing commands, and reading members
- **Embed builder** for rich message formatting
- **Webhook server** for HTTP-callback bots with signature verification
- **Event-driven** architecture with familiar `on`/`once`/`emit` API

## API

### `Client`

The main bot client. Connects via WebSocket and provides the command framework.

```javascript
const bot = new Client({
  prefix: '!',         // Command prefix (default: '!')
  debug: true,         // Enable debug logging
  reconnect: true,     // Auto-reconnect (default: true)
  reconnectDelay: 5000 // Reconnect delay in ms
})

await bot.login(token, serverUrl)
```

**Events:** `ready`, `message`, `messageUpdate`, `messageDelete`, `memberJoin`, `memberLeave`, `reaction`, `channelCreate`, `channelUpdate`, `channelDelete`, `serverUpdate`, `typingStart`, `disconnect`, `reconnect`, `error`

### `CommandRegistry`

```javascript
bot.commands.add({
  name: 'ban',
  description: 'Ban a user',
  aliases: ['b'],
  cooldown: 10,  // seconds
  execute: async (message, args, ctx) => {
    await message.reply(`Banned ${args[0]}`)
  }
})

bot.commands.onError((err, message, cmd) => {
  message.reply(`Error running ${cmd.name}: ${err.message}`)
})
```

### `Embed`

```javascript
import { Embed } from '@voltchat/wire'

const embed = new Embed()
  .setTitle('Server Stats')
  .setColor('#5865f2')
  .addField('Members', '42', true)
  .addField('Channels', '8', true)
  .setFooter('Powered by Wire')
  .setTimestamp()

await bot.send(channelId, '', { embeds: [embed.toJSON()] })
```

### `RestClient`

Use the REST API without a WebSocket connection.

```javascript
import { RestClient } from '@voltchat/wire'

const rest = new RestClient('https://your-server.com', 'vbot_token')
await rest.sendMessage(channelId, 'Hello!')
await rest.setStatus('online')
const members = await rest.getServerMembers(serverId)
```

### `WebhookServer`

Receive events via HTTP instead of WebSocket.

```javascript
import { WebhookServer } from '@voltchat/wire'

const server = new WebhookServer({
  port: 3100,
  secret: 'your_webhook_secret',
  path: '/webhook'
})

server.on('MESSAGE_CREATE', (data) => {
  console.log('New message:', data.message.content)
})

await server.start()
```

## Constants

```javascript
import { Intents, Permissions, GatewayEvents, BotStatus } from '@voltchat/wire'
```

## License

MIT
