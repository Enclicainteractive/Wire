import { io } from 'socket.io-client'
import { EventEmitter } from './EventEmitter.js'
import { RestClient } from './RestClient.js'
import { CommandRegistry } from './CommandRegistry.js'
import { Message } from './Message.js'
import { VoiceConnection } from './VoiceConnection.js'
import { GatewayEvents, BotStatus } from './constants.js'

export class Client extends EventEmitter {
  constructor(options = {}) {
    super()
    this.token      = null
    this.userToken  = options.userToken  || null
    this.serverUrl  = options.serverUrl  || null
    this.rest       = null
    this.socket     = null
    this.bot        = null
    this.commands   = new CommandRegistry(options.prefix || '!')
    this.readyAt    = null

    // Caches — plain Maps, populated from gateway events
    this.servers    = new Map()   // serverId  -> server data
    this.channels   = new Map()   // channelId -> channel data
    this.members    = new Map()   // `${serverId}:${userId}` -> member data

    this._reconnect       = options.reconnect !== false
    this._reconnectDelay  = options.reconnectDelay || 5000
    this._debug           = options.debug || false
    this._typingTimers    = new Map()   // channelId -> timer handle

    // Voice — keyed by serverId so one connection per server
    this._voiceConnections = new Map()  // serverId -> VoiceConnection
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  _log(...args) {
    if (this._debug) console.log('[Wire]', ...args)
  }

  _normalizeGatewayUrl(url) {
    if (typeof url !== 'string') return url
    // Convert raw WebSocket schemes to HTTP(S) — socket.io needs HTTP(S).
    url = url.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://')
    // If the user supplied an https:// server URL but the gateway returned
    // http://, upgrade it (server-side misconfiguration behind a proxy).
    if (this.serverUrl?.startsWith('https://') && url.startsWith('http://')) {
      url = 'https://' + url.slice('http://'.length)
    }
    return url
  }

  // ---------------------------------------------------------------------------
  // Login / connect
  // ---------------------------------------------------------------------------

  /**
   * Authenticate and open the WebSocket gateway connection.
   * @param {string} token     Bot token (vbot_…)
   * @param {string} serverUrl Base URL of the VoltChat server.
   * @returns {Promise<object>} Resolves with the bot's profile when ready.
   */
  async login(token, serverUrl) {
    if (token)     this.token     = token
    if (serverUrl) this.serverUrl = serverUrl

    if (!this.token)     throw new Error('Bot token is required.')
    if (!this.serverUrl) throw new Error('Server URL is required.')

    this.rest = new RestClient(this.serverUrl, this.token)

    const [gateway, me] = await Promise.all([
      this.rest.getGateway(),
      this.rest.getMe()
    ])

    this.bot = me
    // Derive the host from the serverUrl (bots are local to their server, no user host)
    try {
      this.serverHost = new URL(this.serverUrl).host
    } catch {
      this.serverHost = this.serverUrl
    }
    this.bot.serverHost = this.serverHost
    this._log('Authenticated as', me.name, `(${me.id}) on ${this.serverHost}`)
    this._log('Gateway URL from server:', gateway.url || '(none, using serverUrl)')

    return this._connectGateway(gateway.url || this.serverUrl)
  }

  _connectGateway(rawUrl) {
    const url = this._normalizeGatewayUrl(rawUrl)
    if (url !== rawUrl) this._log(`Gateway URL normalized: ${rawUrl} -> ${url}`)

    const secure = url.startsWith('https://')

    return new Promise((resolve, reject) => {
      const authToken = this.userToken || this.token

      this._log(`Connecting to gateway: ${url} (secure=${secure})`)

      this.socket = io(url, {
        auth: { token: authToken },
        reconnection: this._reconnect,
        reconnectionDelay: this._reconnectDelay,
        transports: ['websocket', 'polling'],
        secure
      })

      // -- Connection lifecycle --

      this.socket.on('connect', () => {
        this._log('WebSocket connected (transport:', this.socket.io.engine.transport.name + ')')
        this.socket.emit('bot:connect', { botToken: this.token })
      })

      this.socket.on('bot:ready', (data) => {
        this.readyAt = new Date()
        this.bot = { ...this.bot, ...data }
        this._log('Ready! Serving', data.servers?.length || 0, 'servers')

        // Join server rooms
        if (data.servers) {
          for (const serverId of data.servers) {
            this.socket.emit('server:join', serverId)
          }
        }

        // Sync commands
        if (this.commands.commands.size > 0) {
          this.rest.registerCommands(this.commands.toArray()).catch(err => {
            this._log('Failed to sync commands:', err.message)
          })
        }

        this.rest.setStatus(BotStatus.ONLINE).catch(() => {})
        this.emit('ready', this.bot)
        resolve(this.bot)
      })

      this.socket.on(GatewayEvents.BOT_ERROR, (data) => {
        this._log('Bot error from server:', data?.error)
        this.emit('botError', data)
      })

      // -- Messages --

      this.socket.on(GatewayEvents.MESSAGE_CREATE, (data) => {
        const message = new Message(data, this)
        if (message.userId === this.bot?.id) return   // skip own messages
        this.emit('message', message)
        this.commands.handle(message)
      })

      this.socket.on(GatewayEvents.MESSAGE_UPDATE, (data) => {
        this.emit('messageUpdate', data)
      })

      this.socket.on(GatewayEvents.MESSAGE_EDITED, (data) => {
        this.emit('messageEdit', new Message(data, this))
      })

      this.socket.on(GatewayEvents.MESSAGE_DELETE, (data) => {
        this.emit('messageDelete', data)
      })

      this.socket.on(GatewayEvents.MESSAGE_PINNED, (data) => {
        this.emit('messagePinned', data)
      })

      this.socket.on(GatewayEvents.MESSAGE_UNPINNED, (data) => {
        this.emit('messageUnpinned', data)
      })

      // -- Reactions --

      this.socket.on(GatewayEvents.REACTION_UPDATE, (data) => {
        // Emit granular events based on the action field as well as the raw one
        this.emit('reaction', data)
        if (data.action === 'add')    this.emit('reactionAdd', data)
        if (data.action === 'remove') this.emit('reactionRemove', data)
      })

      // -- Members --

      this.socket.on(GatewayEvents.MEMBER_JOIN, (data) => {
        if (data.serverId && data.id) {
          // Cache member with host for federated identity awareness
          this.members.set(`${data.serverId}:${data.id}`, {
            ...data,
            federatedId: data.host ? `@${data.username}:${data.host}` : `@${data.username}`
          })
        }
        this.emit('memberJoin', data)
      })

      this.socket.on(GatewayEvents.MEMBER_LEAVE, (data) => {
        if (data.serverId && data.id) {
          this.members.delete(`${data.serverId}:${data.id}`)
        }
        this.emit('memberLeave', data)
      })

      this.socket.on(GatewayEvents.MEMBER_OFFLINE, (data) => {
        this.emit('memberOffline', data)
      })

      // -- Channels --

      this.socket.on(GatewayEvents.CHANNEL_CREATE, (data) => {
        if (data.id) this.channels.set(data.id, data)
        this.emit('channelCreate', data)
      })

      this.socket.on(GatewayEvents.CHANNEL_UPDATE, (data) => {
        if (data.id) this.channels.set(data.id, data)
        this.emit('channelUpdate', data)
      })

      this.socket.on(GatewayEvents.CHANNEL_DELETE, (data) => {
        if (data.channelId) this.channels.delete(data.channelId)
        this.emit('channelDelete', data)
      })

      // -- Servers --

      this.socket.on(GatewayEvents.SERVER_UPDATE, (data) => {
        if (data.id) this.servers.set(data.id, data)
        this.emit('serverUpdate', data)
      })

      // -- Typing --

      this.socket.on(GatewayEvents.TYPING_START, (data) => {
        this.emit('typingStart', data)
      })

      // -- Voice --

      this.socket.on(GatewayEvents.VOICE_JOIN, (data) => {
        // Resolve channel name from cache if available
        const channelId = data.channelId
        const channel = channelId ? this.channels.get(channelId) : null
        this.emit('voiceJoin', {
          ...data,
          channelName: channel?.name || channelId || 'unknown'
        })
      })

      this.socket.on(GatewayEvents.VOICE_LEAVE, (data) => {
        const channelId = data.channelId
        const channel = channelId ? this.channels.get(channelId) : null
        this.emit('voiceLeave', {
          ...data,
          channelName: channel?.name || channelId || 'unknown'
        })
      })

      this.socket.on(GatewayEvents.VOICE_USER_UPDATE, (data) => {
        this.emit('voiceUpdate', data)
      })

      // -- Presence --

      this.socket.on(GatewayEvents.USER_STATUS, (data) => {
        this.emit('userStatus', data)
      })

      // -- Connection lifecycle --

      this.socket.on('disconnect', (reason) => {
        this._log('Disconnected:', reason)
        this._clearAllTypingTimers()
        this.emit('disconnect', reason)
      })

      this.socket.on('reconnect', () => {
        this._log('Reconnected')
        // Re-join any active voice channels after a gateway reconnect
        for (const vc of this._voiceConnections.values()) {
          if (vc.connected) {
            this._log(`Re-joining voice channel ${vc.channelId} after reconnect`)
            this.socket.emit('voice:join', {
              channelId: vc.channelId,
              serverId:  vc.serverId,
              peerId:    this.bot?.id,
            })
          }
        }
        this.emit('reconnect')
      })

      this.socket.on('connect_error', (err) => {
        const detail = [
          `message: ${err.message}`,
          err.description ? `description: ${err.description}` : null,
          err.type        ? `type: ${err.type}`                : null,
          err.context     ? `context: ${JSON.stringify(err.context)}` : null,
          err.cause       ? `cause: ${err.cause?.message ?? err.cause}` : null,
        ].filter(Boolean).join(' | ')

        this._log(`Connection error [${url}] — ${detail}`)
        if (this._debug && err.stack) console.log('[Wire] Stack:', err.stack)

        err.gatewayUrl = url
        err.detail     = detail

        this.emit('error', err)
        if (!this.readyAt) reject(err)
      })
    })
  }

  // ---------------------------------------------------------------------------
  // Convenience methods
  // ---------------------------------------------------------------------------

  /**
   * Send a message to a channel.
   */
  async send(channelId, content, options = {}) {
    return this.rest.sendMessage(channelId, content, options)
  }

  /**
   * Send a typing indicator in a channel.
   * Optionally keep it going every 8 s until stopTyping() is called.
   * @param {string}  channelId
   * @param {boolean} [continuous=false]
   */
  async startTyping(channelId, continuous = false) {
    await this.rest.sendTyping(channelId).catch(() => {})
    if (continuous && !this._typingTimers.has(channelId)) {
      const timer = setInterval(() => {
        this.rest.sendTyping(channelId).catch(() => {})
      }, 8000)
      this._typingTimers.set(channelId, timer)
    }
  }

  /**
   * Stop the continuous typing indicator for a channel.
   * @param {string} channelId
   */
  stopTyping(channelId) {
    const timer = this._typingTimers.get(channelId)
    if (timer) {
      clearInterval(timer)
      this._typingTimers.delete(channelId)
    }
  }

  _clearAllTypingTimers() {
    for (const timer of this._typingTimers.values()) clearInterval(timer)
    this._typingTimers.clear()
  }

  /**
   * Set the bot's status and optional custom status text.
   *
   * Emits a `bot:status-change` event over the already-open WebSocket for
   * an instant broadcast to all connected clients, then also persists the
   * change via the REST API so it survives reconnects.
   *
   * @param {'online'|'idle'|'dnd'|'offline'} status
   * @param {string|null} [customStatus]  Short text shown under the bot's name
   */
  async setStatus(status, customStatus = null) {
    // Instant path — push over the live socket so the sidebar updates now
    if (this.socket?.connected) {
      this.socket.emit('bot:status-change', { status, customStatus })
    }
    // Persist path — REST call so the status survives a reconnect
    return this.rest.setStatus(status, customStatus)
  }

  /**
   * Fetch and cache a server's channels.
   * @param {string} serverId
   */
  async fetchChannels(serverId) {
    const channels = await this.rest.getChannels(serverId)
    for (const c of (Array.isArray(channels) ? channels : [])) {
      this.channels.set(c.id, c)
    }
    return channels
  }

  /**
   * Fetch server info and cache it.
   * @param {string} serverId
   */
  async fetchServer(serverId) {
    const server = await this.rest.getServer(serverId)
    if (server?.id) this.servers.set(server.id, server)
    return server
  }

  /**
   * Fetch all members of a server and cache them with federated identity.
   * @param {string} serverId
   * @returns {Promise<Array>} Members with federatedId field populated.
   */
  async fetchMembers(serverId) {
    const members = await this.rest.getServerMembers(serverId)
    for (const m of (Array.isArray(members) ? members : [])) {
      const enriched = {
        ...m,
        federatedId: (!m.isBot && m.host) ? `@${m.username}:${m.host}` : null
      }
      this.members.set(`${serverId}:${m.id}`, enriched)
    }
    return members
  }

  /**
   * Get a cached member from a server.
   * @param {string} serverId
   * @param {string} userId
   * @returns {object|undefined}
   */
  getMember(serverId, userId) {
    return this.members.get(`${serverId}:${userId}`)
  }

  /**
   * Get the full federated identity string for a user in a server.
   * Returns "@username:host" for regular users, null for bots.
   * @param {string} serverId
   * @param {string} userId
   * @returns {string|null}
   */
  getMemberFederatedId(serverId, userId) {
    const member = this.getMember(serverId, userId)
    if (!member || member.isBot) return null
    return member.host ? `@${member.username}:${member.host}` : null
  }

  /**
   * Parse all @username:host mentions from a content string.
   * Returns an array of { raw, username, host, federatedId }.
   * @param {string} content
   * @returns {Array<{raw:string, username:string, host:string|null, federatedId:string}>}
   */
  parseMentions(content) {
    const results = []
    const re = /@([a-zA-Z0-9_\-.]+)(?::([a-zA-Z0-9_\-.]+))?/g
    let m
    while ((m = re.exec(content)) !== null) {
      const username = m[1]
      const host = m[2] || null
      if (username === 'everyone' || username === 'here') continue
      results.push({
        raw: m[0],
        username,
        host,
        federatedId: host ? `@${username}:${host}` : `@${username}`
      })
    }
    return results
  }

  // ---------------------------------------------------------------------------
  // Voice
  // ---------------------------------------------------------------------------

  /**
   * Join a voice channel and return a VoiceConnection.
   * If the bot is already in a voice channel in the same server the existing
   * connection is left first.
   *
   * @param {string} serverId
   * @param {string} channelId
   * @param {object} [options]
   * @param {boolean} [options.debug]   Enable verbose WebRTC logging
   * @returns {Promise<VoiceConnection>}
   */
  async joinVoice(serverId, channelId, options = {}) {
    // Leave any existing connection in this server
    await this.leaveVoice(serverId)

    const vc = new VoiceConnection(this.socket, this.bot?.id, serverId, channelId, {
      debug: this._debug || options.debug,
    })
    this._voiceConnections.set(serverId, vc)

    await vc.join()
    return vc
  }

  /**
   * Leave the voice channel in the given server (if any).
   * @param {string} serverId
   */
  async leaveVoice(serverId) {
    const vc = this._voiceConnections.get(serverId)
    if (vc) {
      vc.leave()
      this._voiceConnections.delete(serverId)
    }
  }

  /**
   * Get the active VoiceConnection for a server, or undefined.
   * @param {string} serverId
   * @returns {VoiceConnection|undefined}
   */
  getVoiceConnection(serverId) {
    return this._voiceConnections.get(serverId)
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Milliseconds since the bot became ready. */
  get uptime() {
    if (!this.readyAt) return 0
    return Date.now() - this.readyAt.getTime()
  }

  /** Whether the bot is currently connected and ready. */
  get isReady() {
    return this.readyAt !== null && this.socket?.connected === true
  }

  /**
   * Gracefully shut down — set offline status, disconnect socket, clean up.
   */
  destroy() {
    this._clearAllTypingTimers()
    // Tear down all voice connections cleanly
    for (const vc of this._voiceConnections.values()) vc.leave()
    this._voiceConnections.clear()
    this.rest?.setStatus(BotStatus.OFFLINE).catch(() => {})
    this.socket?.disconnect()
    this.removeAllListeners()
    this.readyAt = null
  }
}
