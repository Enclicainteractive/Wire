import { io } from 'socket.io-client'
import { EventEmitter } from './EventEmitter.js'
import { RestClient } from './RestClient.js'
import { CommandRegistry } from './CommandRegistry.js'
import { Message } from './Message.js'
import { GatewayEvents, BotStatus } from './constants.js'

export class Client extends EventEmitter {
  constructor(options = {}) {
    super()
    this.token = null
    this.userToken = options.userToken || null
    this.serverUrl = options.serverUrl || null
    this.rest = null
    this.socket = null
    this.bot = null
    this.commands = new CommandRegistry(options.prefix || '!')
    this.readyAt = null
    this._reconnect = options.reconnect !== false
    this._reconnectDelay = options.reconnectDelay || 5000
    this._debug = options.debug || false
  }

  _log(...args) {
    if (this._debug) console.log('[Wire]', ...args)
  }

  async login(token, serverUrl) {
    if (token) this.token = token
    if (serverUrl) this.serverUrl = serverUrl

    if (!this.token) throw new Error('Bot token is required. Call client.login(token, serverUrl)')
    if (!this.serverUrl) throw new Error('Server URL is required. Call client.login(token, serverUrl)')

    this.rest = new RestClient(this.serverUrl, this.token)

    // Fetch gateway info and bot identity
    const [gateway, me] = await Promise.all([
      this.rest.getGateway(),
      this.rest.getMe()
    ])

    this.bot = me
    this._log('Authenticated as', me.name, `(${me.id})`)

    // Connect via WebSocket
    return this._connectGateway(gateway.url || this.serverUrl)
  }

  _connectGateway(url) {
    return new Promise((resolve, reject) => {
      const authToken = this.userToken || this.token

      this.socket = io(url, {
        auth: { token: authToken },
        reconnection: this._reconnect,
        reconnectionDelay: this._reconnectDelay,
        transports: ['websocket', 'polling']
      })

      this.socket.on('connect', () => {
        this._log('WebSocket connected')
        this.socket.emit('bot:connect', { botToken: this.token })
      })

      this.socket.on('bot:ready', (data) => {
        this.readyAt = new Date()
        this.bot = { ...this.bot, ...data }
        this._log('Ready! Serving', data.servers?.length || 0, 'servers')

        // Auto-join server rooms
        if (data.servers) {
          for (const serverId of data.servers) {
            this.socket.emit('server:join', serverId)
          }
        }

        // Sync registered commands
        if (this.commands.commands.size > 0) {
          this.rest.registerCommands(this.commands.toArray()).catch(err => {
            this._log('Failed to sync commands:', err.message)
          })
        }

        this.rest.setStatus(BotStatus.ONLINE).catch(() => {})
        this.emit('ready', this.bot)
        resolve(this.bot)
      })

      this.socket.on(GatewayEvents.MESSAGE_CREATE, (data) => {
        const message = new Message(data, this)
        // Skip own messages
        if (message.userId === this.bot?.id) return

        this.emit('message', message)
        this.commands.handle(message)
      })

      this.socket.on(GatewayEvents.MESSAGE_UPDATE, (data) => {
        this.emit('messageUpdate', data)
      })

      this.socket.on(GatewayEvents.MESSAGE_DELETE, (data) => {
        this.emit('messageDelete', data)
      })

      this.socket.on(GatewayEvents.MEMBER_JOIN, (data) => {
        this.emit('memberJoin', data)
      })

      this.socket.on(GatewayEvents.MEMBER_LEAVE, (data) => {
        this.emit('memberLeave', data)
      })

      this.socket.on(GatewayEvents.REACTION_ADD, (data) => {
        this.emit('reaction', data)
      })

      this.socket.on(GatewayEvents.CHANNEL_CREATE, (data) => {
        this.emit('channelCreate', data)
      })

      this.socket.on(GatewayEvents.CHANNEL_UPDATE, (data) => {
        this.emit('channelUpdate', data)
      })

      this.socket.on(GatewayEvents.CHANNEL_DELETE, (data) => {
        this.emit('channelDelete', data)
      })

      this.socket.on(GatewayEvents.SERVER_UPDATE, (data) => {
        this.emit('serverUpdate', data)
      })

      this.socket.on(GatewayEvents.TYPING_START, (data) => {
        this.emit('typingStart', data)
      })

      this.socket.on('disconnect', (reason) => {
        this._log('Disconnected:', reason)
        this.emit('disconnect', reason)
      })

      this.socket.on('reconnect', () => {
        this._log('Reconnected')
        this.emit('reconnect')
      })

      this.socket.on('connect_error', (err) => {
        this._log('Connection error:', err.message)
        this.emit('error', err)
        if (!this.readyAt) reject(err)
      })
    })
  }

  async send(channelId, content, options = {}) {
    return this.rest.sendMessage(channelId, content, options)
  }

  async setStatus(status) {
    return this.rest.setStatus(status)
  }

  get uptime() {
    if (!this.readyAt) return 0
    return Date.now() - this.readyAt.getTime()
  }

  destroy() {
    this.rest?.setStatus(BotStatus.OFFLINE).catch(() => {})
    this.socket?.disconnect()
    this.removeAllListeners()
    this.readyAt = null
  }
}
