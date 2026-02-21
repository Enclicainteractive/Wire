export class RestClient {
  constructor(baseUrl, botToken) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.botToken = botToken
  }

  async _request(method, path, body) {
    const url = `${this.baseUrl}${path}`
    const headers = {
      'Authorization': `Bot ${this.botToken}`,
      'Content-Type': 'application/json'
    }

    const opts = { method, headers }
    if (body !== undefined && method !== 'GET') {
      opts.body = JSON.stringify(body)
    }

    const res = await fetch(url, opts)
    const text = await res.text()

    let data
    try { data = JSON.parse(text) } catch { data = text }

    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}: ${res.statusText}`)
      err.status = res.status
      err.data = data
      throw err
    }

    return data
  }

  // -------------------------------------------------------------------------
  // Bot identity
  // -------------------------------------------------------------------------

  /** Get the bot's own profile. */
  async getMe() {
    return this._request('GET', '/api/bots/api/me')
  }

  /** Get the gateway WebSocket URL. */
  async getGateway() {
    return this._request('GET', '/api/bots/api/gateway')
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  /**
   * Send a message to a channel.
   * @param {string} channelId
   * @param {string|object} content  Plain string or full body object.
   * @param {object} [options]       Extra fields merged into the body (embeds, replyTo, …).
   */
  async sendMessage(channelId, content, options = {}) {
    const body = typeof content === 'string'
      ? { content, ...options }
      : { ...content, ...options }
    return this._request('POST', `/api/bots/api/channels/${channelId}/messages`, body)
  }

  /**
   * Edit a message the bot previously sent.
   * @param {string} channelId
   * @param {string} messageId
   * @param {string|object} content
   */
  async editMessage(channelId, messageId, content) {
    const body = typeof content === 'string' ? { content } : content
    return this._request('PUT', `/api/bots/api/channels/${channelId}/messages/${messageId}`, body)
  }

  /**
   * Delete a message.
   * @param {string} channelId
   * @param {string} messageId
   */
  async deleteMessage(channelId, messageId) {
    return this._request('DELETE', `/api/bots/api/channels/${channelId}/messages/${messageId}`)
  }

  /**
   * Pin a message in a channel.
   * @param {string} channelId
   * @param {string} messageId
   */
  async pinMessage(channelId, messageId) {
    return this._request('POST', `/api/bots/api/channels/${channelId}/messages/${messageId}/pin`)
  }

  /**
   * Unpin a message in a channel.
   * @param {string} channelId
   * @param {string} messageId
   */
  async unpinMessage(channelId, messageId) {
    return this._request('DELETE', `/api/bots/api/channels/${channelId}/messages/${messageId}/pin`)
  }

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------

  /**
   * Add a reaction to a message.
   * @param {string} channelId
   * @param {string} messageId
   * @param {string} emoji
   */
  async addReaction(channelId, messageId, emoji) {
    return this._request('POST', `/api/bots/api/channels/${channelId}/messages/${messageId}/reactions`, { emoji })
  }

  /**
   * Remove a reaction from a message.
   * @param {string} channelId
   * @param {string} messageId
   * @param {string} emoji
   */
  async removeReaction(channelId, messageId, emoji) {
    return this._request('DELETE', `/api/bots/api/channels/${channelId}/messages/${messageId}/reactions`, { emoji })
  }

  // -------------------------------------------------------------------------
  // Channels
  // -------------------------------------------------------------------------

  /**
   * Get all channels in a server.
   * @param {string} serverId
   */
  async getChannels(serverId) {
    return this._request('GET', `/api/bots/api/servers/${serverId}/channels`)
  }

  /**
   * Get a single channel by ID.
   * @param {string} channelId
   */
  async getChannel(channelId) {
    return this._request('GET', `/api/bots/api/channels/${channelId}`)
  }

  /**
   * Get members of a voice channel.
   * @param {string} channelId
   */
  async getChannelMembers(channelId) {
    return this._request('GET', `/api/bots/api/channels/${channelId}/members`)
  }

  /**
   * Send a typing indicator in a channel.
   * @param {string} channelId
   */
  async sendTyping(channelId) {
    return this._request('POST', `/api/bots/api/channels/${channelId}/typing`)
  }

  // -------------------------------------------------------------------------
  // Servers
  // -------------------------------------------------------------------------

  /**
   * Get server info (name, icon, member count, channels, roles, …).
   * @param {string} serverId
   */
  async getServer(serverId) {
    return this._request('GET', `/api/bots/api/servers/${serverId}`)
  }

  /**
   * Get members of a server.
   * @param {string} serverId
   */
  async getServerMembers(serverId) {
    return this._request('GET', `/api/bots/api/servers/${serverId}/members`)
  }

  /**
   * Get a single member of a server.
   * @param {string} serverId
   * @param {string} userId
   */
  async getServerMember(serverId, userId) {
    return this._request('GET', `/api/bots/api/servers/${serverId}/members/${userId}`)
  }

  /**
   * Kick a member from a server.
   * @param {string} serverId
   * @param {string} userId
   * @param {string} [reason]
   */
  async kickMember(serverId, userId, reason) {
    return this._request('DELETE', `/api/bots/api/servers/${serverId}/members/${userId}`, { reason })
  }

  /**
   * Ban a member from a server.
   * @param {string} serverId
   * @param {string} userId
   * @param {string} [reason]
   * @param {number} [deleteMessageDays=0]
   */
  async banMember(serverId, userId, reason, deleteMessageDays = 0) {
    return this._request('POST', `/api/bots/api/servers/${serverId}/bans/${userId}`, { reason, deleteMessageDays })
  }

  /**
   * Unban a member from a server.
   * @param {string} serverId
   * @param {string} userId
   */
  async unbanMember(serverId, userId) {
    return this._request('DELETE', `/api/bots/api/servers/${serverId}/bans/${userId}`)
  }

  /**
   * Get the ban list for a server.
   * @param {string} serverId
   */
  async getBans(serverId) {
    return this._request('GET', `/api/bots/api/servers/${serverId}/bans`)
  }

  /**
   * Get the roles of a server.
   * @param {string} serverId
   */
  async getRoles(serverId) {
    return this._request('GET', `/api/bots/api/servers/${serverId}/roles`)
  }

  /**
   * Assign a role to a member.
   * @param {string} serverId
   * @param {string} userId
   * @param {string} roleId
   */
  async addRole(serverId, userId, roleId) {
    return this._request('POST', `/api/bots/api/servers/${serverId}/members/${userId}/roles/${roleId}`)
  }

  /**
   * Remove a role from a member.
   * @param {string} serverId
   * @param {string} userId
   * @param {string} roleId
   */
  async removeRole(serverId, userId, roleId) {
    return this._request('DELETE', `/api/bots/api/servers/${serverId}/members/${userId}/roles/${roleId}`)
  }

  // -------------------------------------------------------------------------
  // Commands & Status
  // -------------------------------------------------------------------------

  /**
   * Register/sync slash commands with the server.
   * @param {Array<{name,description,usage}>} commands
   */
  async registerCommands(commands) {
    return this._request('PUT', '/api/bots/api/commands', { commands })
  }

  /**
   * Update the bot's online status.
   * @param {'online'|'idle'|'dnd'|'offline'} status
   * @param {string} [customStatus]
   */
  async setStatus(status, customStatus) {
    return this._request('PUT', '/api/bots/api/status', { status, ...(customStatus ? { customStatus } : {}) })
  }
}
