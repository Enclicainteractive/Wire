import { io } from 'socket.io-client'
import { EventEmitter } from './EventEmitter.js'
import { RestClient } from './RestClient.js'
import { CommandRegistry } from './CommandRegistry.js'
import { Message } from './Message.js'
import { MessageTracker } from './MessageTracker.js'
import { WireCUI } from './WireCUI.js'
import { VoiceConnection } from './VoiceConnection.js'
import { GatewayEvents, BotStatus } from './constants.js'
import * as Encryption from './Encryption.js'

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
    this._encryptionRefreshTimer = null
    this._encryptionRefreshIntervalMs = options.encryptionRefreshIntervalMs || 45000
    this._messageTrackingEnabled = options.messageTracking !== false
    this.messageTracker = this._messageTrackingEnabled
      ? new MessageTracker(this, { maxMessages: options.maxTrackedMessages || 5000 })
      : null

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

  _getKnownServerIds() {
    const serverIds = new Set()
    for (const id of (this.bot?.servers || [])) {
      if (id) serverIds.add(id)
    }
    for (const id of this.servers.keys()) {
      if (id) serverIds.add(id)
    }
    return Array.from(serverIds)
  }

  _stopEncryptionRefreshLoop() {
    if (this._encryptionRefreshTimer) {
      clearInterval(this._encryptionRefreshTimer)
      this._encryptionRefreshTimer = null
    }
  }

  _startEncryptionRefreshLoop() {
    this._stopEncryptionRefreshLoop()
    if (!this.rest) return

    this._encryptionRefreshTimer = setInterval(async () => {
      const serverIds = this._getKnownServerIds()
      if (serverIds.length === 0) return

      const results = await Promise.allSettled(
        serverIds.map((serverId) => Encryption.initializeEncryptionFromServer(serverId, this.rest))
      )
      const loaded = results.filter(r => r.status === 'fulfilled' && r.value?.hasKey).length
      if (loaded > 0) this._log(`Background key refresh OK for ${loaded}/${serverIds.length} servers`)
    }, this._encryptionRefreshIntervalMs)
  }

  async _resolveServerIdForMessage(message) {
    if (message?.serverId) return message.serverId
    if (!message?.channelId) return null

    const cachedChannel = this.channels.get(message.channelId)
    if (cachedChannel?.serverId) {
      message.serverId = cachedChannel.serverId
      return message.serverId
    }

    if (!this.rest) return null
    try {
      const channel = await this.rest.getChannel(message.channelId)
      if (channel?.id) this.channels.set(channel.id, channel)
      if (channel?.serverId) {
        message.serverId = channel.serverId
        return message.serverId
      }
    } catch (err) {
      this._log(`Failed to resolve server for channel ${message.channelId}: ${err.message}`)
    }
    return null
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
    try {
      this.serverHost = new URL(this.serverUrl).host
    } catch {
      this.serverHost = this.serverUrl
    }
    this.bot.serverHost = this.serverHost
    this._log('Authenticated as', me.name, `(${me.id}) on ${this.serverHost}`)
    this._log('Gateway URL from server:', gateway.url || '(none, using serverUrl)')

    Encryption.autoLoadKeys()
    if (Encryption.loadKeysFromBackup().keysLoaded > 0) {
      this._log(`Loaded encryption keys from JSON file`)
    } else {
      this._log('No encryption keys found in JSON file - encrypted messages will not be readable')
    }

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

        if (data.servers) {
          for (const serverId of data.servers) {
            this.socket.emit('server:join', serverId)
          }

          // Best-effort preload of encryption keys so first encrypted messages
          // can be decrypted immediately after startup.
          Promise.allSettled(
            data.servers.map((serverId) => Encryption.initializeEncryptionFromServer(serverId, this.rest))
          ).then((results) => {
            const loaded = results.filter(r => r.status === 'fulfilled' && r.value?.hasKey).length
            if (loaded > 0) this._log(`Preloaded encryption keys for ${loaded}/${data.servers.length} servers`)
          })
        }

        this._startEncryptionRefreshLoop()

        if (this.commands.commands.size > 0) {
          this.rest.registerCommands(this.commands.toArray()).catch(err => {
            this._log('Failed to sync commands:', err.message)
          })
        }

        this.socket.emit('bot:status-change', { status: 'online', customStatus: null })
        this.rest.setStatus(BotStatus.ONLINE).catch(() => {})
        this._log('Bot status set to online')
        
        const keyResult = Encryption.autoLoadKeys()
        if (keyResult.keysLoaded > 0) {
          this._log(`Loaded ${keyResult.keysLoaded} encryption keys from JSON`)
        }
        
        this.emit('ready', this.bot)
        resolve(this.bot)
      })

      this.socket.on(GatewayEvents.BOT_ERROR, (data) => {
        this._log('Bot error from server:', data?.error)
        this.emit('botError', data)
      })

      // -- Messages --

      this.socket.on(GatewayEvents.MESSAGE_CREATE, async (data) => {
        const message = new Message(data, this)
        const serverId = await this._resolveServerIdForMessage(message)
        
        if (message.encrypted && serverId) {
          if (!Encryption.hasServerKey(serverId)) {
            // First try loading from JSON backup files
            const result = Encryption.autoLoadKeys()
            if (result.keysLoaded > 0) {
              this._log(`Loaded ${result.keysLoaded} encryption keys from backup`)
            }
            
            // If still no key, try to get it from the server
            if (!Encryption.hasServerKey(serverId) && this.rest) {
              try {
                const initResult = await Encryption.initializeEncryptionFromServer(serverId, this.rest)
                if (initResult.hasKey) {
                  this._log(`Got encryption key for ${serverId} from server (${initResult.source})`)
                }
              } catch (err) {
                this._log(`Failed to get encryption key from server: ${err.message}`)
              }
            }
          }
          
          if (Encryption.hasServerKey(serverId) && Encryption.isEncryptedMessage(message)) {
            let decrypted = Encryption.decryptMessageContent(message, serverId)
            if ((!decrypted || decrypted === message.content) && this.rest) {
              // Key may be stale after rotation; refresh key bundle and retry once.
              await Encryption.initializeEncryptionFromServer(serverId, this.rest)
              decrypted = Encryption.decryptMessageContent(message, serverId)
            }
            if (decrypted && decrypted !== message.content) {
              message.content = decrypted
              message._decrypted = true
              this._log(`Decrypted message in server ${serverId}`)
            }
          }
        }
        
        if (message._decryptedForBot && message.content) {
          message._decrypted = true
        }
        
        if (this.messageTracker) this.messageTracker.upsertMessage(message)
        if (message.userId === this.bot?.id) return
        this.emit('message', message)
        this.commands.handle(message)
      })

      this.socket.on(GatewayEvents.MESSAGE_UPDATE, (data) => {
        if (this.messageTracker) this.messageTracker.patchMessage(data)
        this.emit('messageUpdate', data)
      })

      this.socket.on(GatewayEvents.MESSAGE_EDITED, async (data) => {
        const edited = new Message(data, this)
        await this._resolveServerIdForMessage(edited)
        const editedServerId = edited.serverId

        if (edited.encrypted && editedServerId) {
          if (!Encryption.hasServerKey(editedServerId) && this.rest) {
            try {
              await Encryption.initializeEncryptionFromServer(editedServerId, this.rest)
            } catch (err) {
              this._log(`Failed to initialize encryption for edited message in ${editedServerId}: ${err.message}`)
            }
          }
          if (Encryption.hasServerKey(editedServerId) && Encryption.isEncryptedMessage(edited)) {
            let decrypted = Encryption.decryptMessageContent(edited, editedServerId)
            if ((!decrypted || decrypted === edited.content) && this.rest) {
              await Encryption.initializeEncryptionFromServer(editedServerId, this.rest)
              decrypted = Encryption.decryptMessageContent(edited, editedServerId)
            }
            if (decrypted && decrypted !== edited.content) {
              edited.content = decrypted
              edited._decrypted = true
            }
          }
        }
        
        if (this.messageTracker) this.messageTracker.upsertMessage(edited)

        this.emit('messageEdit', edited)
      })

      this.socket.on(GatewayEvents.MESSAGE_DELETE, (data) => {
        if (this.messageTracker) this.messageTracker.deleteMessage(data.messageId || data.id, data.channelId)
        this.emit('messageDelete', data)
      })

      this.socket.on(GatewayEvents.MESSAGE_PINNED, (data) => {
        if (this.messageTracker) this.messageTracker.patchMessage({ ...data, id: data.messageId || data.id, pinned: true })
        this.emit('messagePinned', data)
      })

      this.socket.on(GatewayEvents.MESSAGE_UNPINNED, (data) => {
        if (this.messageTracker) this.messageTracker.patchMessage({ ...data, id: data.messageId || data.id, pinned: false })
        this.emit('messageUnpinned', data)
      })

      // -- Reactions --

      this.socket.on(GatewayEvents.REACTION_UPDATE, (data) => {
        const tracked = this.messageTracker ? this.messageTracker.applyReactionUpdate(data) : null
        // Emit granular events based on the action field as well as the raw one
        this.emit('reaction', data)
        if (data.action === 'add')    this.emit('reactionAdd', data)
        if (data.action === 'remove') this.emit('reactionRemove', data)
        if (tracked) this.emit('reactionTrackedUpdate', tracked)
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
        this._stopEncryptionRefreshLoop()
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
   * Send an encrypted message to a channel.
   * @param {string} channelId 
   * @param {string} content 
   * @param {string} serverId 
   * @param {object} options 
   */
  async sendEncrypted(channelId, content, serverId, options = {}) {
    const encrypted = Encryption.encryptMessage(content, serverId)
    if (encrypted.encrypted) {
      return this.rest.sendMessage(channelId, encrypted.content, {
        ...options,
        encrypted: true,
        iv: encrypted.iv
      })
    }
    return this.rest.sendMessage(channelId, content, options)
  }

  /**
   * Check if a message is encrypted.
   * @param {object} message 
   * @returns {boolean}
   */
  isEncryptedMessage(message) {
    return Encryption.isEncryptedMessage(message)
  }

  /**
   * Decrypt an encrypted message.
   * @param {object} message 
   * @param {string} serverId 
   * @returns {string|null} Decrypted content or null if decryption failed
   */
  decryptMessage(message, serverId) {
    return Encryption.decryptMessageContent(message, serverId)
  }

  /**
   * Get the encryption key for a server.
   * @param {string} serverId 
   * @returns {string|null}
   */
  getServerKey(serverId) {
    return Encryption.getServerKey(serverId)
  }

  /**
   * Set the encryption key for a server.
   * @param {string} serverId 
   * @param {string} symmetricKey 
   */
  setServerKey(serverId, symmetricKey) {
    return Encryption.setServerKey(serverId, symmetricKey)
  }

  /**
   * Check if the bot has an encryption key for a server.
   * @param {string} serverId 
   * @returns {boolean}
   */
  hasServerKey(serverId) {
    return Encryption.hasServerKey(serverId)
  }

  /**
   * Initialize encryption for a server by fetching keys from the server.
   * @param {string} serverId 
   */
  async initServerEncryption(serverId) {
    return Encryption.initializeEncryptionFromServer(serverId, this.rest)
  }

  /**
   * Load encryption keys from a backup JSON file.
   * @param {string} [filePath] Optional path to the backup file
   * @returns {Promise<{success: boolean, keysLoaded: number}>}
   */
  async loadEncryptionKeys(filePath) {
    return Encryption.loadKeysFromBackup(filePath)
  }

  /**
   * Auto-load encryption keys from common backup locations.
   * @returns {Promise<{success: boolean, keysLoaded: number}>}
   */
  async autoLoadEncryptionKeys() {
    return Encryption.autoLoadKeys()
  }

  /**
   * Initialize encryption for all servers the bot is in.
   * Call this after the bot is ready to enable encryption on all servers.
   */
  async initAllEncryption() {
    console.log('[Wire] Initializing encryption for all servers...')
    
    // First try loading from backup files
    Encryption.autoLoadKeys()
    
    // Get server IDs from bot's known servers
    // The bot.servers might not be populated yet, so check bot.servers from ready event
    let serverIds = this.bot?.servers || []
    
    console.log('[Wire] Bot servers from ready event:', serverIds.length)
    
    if (serverIds.length === 0) {
      console.log('[Wire] No servers known yet, trying to fetch server info...')
      // Try to get server list from REST
      try {
        const me = await this.rest.getMe()
        console.log('[Wire] getMe() response:', JSON.stringify(me).slice(0, 500))
        if (me?.servers) {
          serverIds = me.servers
        }
      } catch (err) {
        console.warn('[Wire] Could not fetch server list:', err.message)
      }
    }
    
    if (serverIds.length === 0) {
      console.log('[Wire] No servers to initialize encryption for')
      return {}
    }
    
    console.log(`[Wire] Initializing encryption for ${serverIds.length} servers:`, serverIds)
    
    const results = {}
    for (const serverId of serverIds) {
      try {
        // Skip if we already have the key
        if (Encryption.hasServerKey(serverId)) {
          results[serverId] = { hasKey: true, source: 'cache' }
          console.log(`[Wire] Already have key for server ${serverId}`)
          continue
        }
        
        console.log(`[Wire] Trying to get key for server ${serverId}...`)
        
        // First check if server has encryption enabled
        try {
          const status = await this.rest.getServerEncryptionStatus(serverId)
          console.log(`[Wire] Encryption status for ${serverId}:`, JSON.stringify(status).slice(0, 200))
        } catch (err) {
          console.log(`[Wire] Could not get encryption status for ${serverId}:`, err.message)
        }
        
        const result = await Encryption.initializeEncryptionFromServer(serverId, this.rest)
        results[serverId] = result
        console.log(`[Wire] Encryption for ${serverId}: ${result.hasKey ? 'OK (' + (result.source || 'unknown') + ')' : 'FAILED - ' + (result.error || 'unknown error')}`)
      } catch (err) {
        results[serverId] = { hasKey: false, error: err.message }
        console.error(`[Wire] Encryption init failed for ${serverId}:`, err.message)
      }
    }
    return results
  }

  /**
   * Get encryption status for a server.
   * @param {string} serverId 
   * @returns {object}
   */
  getEncryptionStatus(serverId) {
    return Encryption.getEncryptionStatus(serverId)
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
  // Message tracking / CUI
  // ---------------------------------------------------------------------------

  /**
   * Get a tracked message by ID.
   * @param {string} messageId
   * @returns {Message|null}
   */
  getTrackedMessage(messageId) {
    return this.messageTracker?.getMessage(messageId) || null
  }

  /**
   * Get tracked messages for a channel.
   * @param {string} channelId
   * @param {{limit?: number, newestFirst?: boolean}} [options]
   * @returns {Message[]}
   */
  getTrackedMessages(channelId, options = {}) {
    return this.messageTracker?.getMessagesByChannel(channelId, options) || []
  }

  /**
   * Get latest known content for a tracked message.
   * @param {string} messageId
   * @returns {string|null}
   */
  getTrackedMessageContent(messageId) {
    return this.messageTracker?.getMessageContent(messageId) ?? null
  }

  /**
   * Get tracked reaction summary for a message.
   * @param {string} messageId
   * @returns {Record<string, {count:number, userIds:string[]}>}
   */
  getTrackedReactions(messageId) {
    return this.messageTracker?.getReactions(messageId) || {}
  }

  /**
   * Get users that reacted with a specific emoji on a tracked message.
   * @param {string} messageId
   * @param {string} emoji
   * @returns {string[]}
   */
  getTrackedReactionUsers(messageId, emoji) {
    return this.messageTracker?.getReactionUsers(messageId, emoji) || []
  }

  /**
   * Clear all tracked message/reaction state.
   */
  clearTrackedState() {
    this.messageTracker?.clear()
  }

  /**
   * Wait for a matching reactionAdd event.
   * @param {string} messageId
   * @param {{emoji?: string, userId?: string, timeoutMs?: number}} [filter]
   * @returns {Promise<object>}
   */
  awaitReaction(messageId, filter = {}) {
    const { emoji = null, userId = null, timeoutMs = 60000 } = filter
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('reactionAdd', onReaction)
        reject(new Error('Timed out waiting for reaction'))
      }, timeoutMs)

      const onReaction = (data) => {
        const dataMessageId = data.messageId || data.id
        const dataEmoji = data.emoji?.emoji || data.emoji?.name || data.emoji || null
        if (dataMessageId !== messageId) return
        if (emoji && dataEmoji !== emoji) return
        if (userId && data.userId !== userId) return
        clearTimeout(timer)
        this.off('reactionAdd', onReaction)
        resolve(data)
      }

      this.on('reactionAdd', onReaction)
    })
  }

  /**
   * Create a reaction/edit-driven chat UI controller for a channel.
   * @param {string} channelId
   * @param {object} [options]
   * @returns {WireCUI}
   */
  createCUI(channelId, options = {}) {
    return new WireCUI(this, { channelId, ...options })
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
   * @param {boolean} [options.encrypted] Enable DTLS-SRTP encryption (default: true)
   * @returns {Promise<VoiceConnection>}
   */
  async joinVoice(serverId, channelId, options = {}) {
    // Leave any existing connection in this server
    await this.leaveVoice(serverId)

    const vc = new VoiceConnection(this.socket, this.bot?.id, serverId, channelId, {
      debug: this._debug || options.debug,
      encrypted: options.encrypted !== false, // Default to encrypted
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
    this._stopEncryptionRefreshLoop()
    // Tear down all voice connections cleanly
    for (const vc of this._voiceConnections.values()) vc.leave()
    this._voiceConnections.clear()
    this.rest?.setStatus(BotStatus.OFFLINE).catch(() => {})
    this.socket?.disconnect()
    this.removeAllListeners()
    this.readyAt = null
  }
}
