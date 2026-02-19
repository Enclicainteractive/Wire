export class Message {
  constructor(data, client) {
    this.id          = data.id
    this.channelId   = data.channelId
    this.serverId    = data.serverId   || null
    this.userId      = data.userId
    this.username    = data.username
    this.host        = data.host       || null  // originating server host of the author
    this.avatar      = data.avatar     || null
    this.content     = data.content    || ''
    this.embeds      = data.embeds     || []
    this.attachments = data.attachments || []
    this.mentions    = data.mentions   || { users: [], usernames: [], federated: [], everyone: false, here: false }
    this.bot         = data.bot        || false
    this.pinned      = data.pinned     || false
    this.replyTo     = data.replyTo    || null
    this.timestamp   = data.timestamp ? new Date(data.timestamp) : new Date()
    this.edited      = data.edited     || false
    this._client     = client
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /**
   * Shorthand author object including the author's host for federated identity.
   * For bots, host is null.
   */
  get author() {
    return {
      id: this.userId,
      username: this.username,
      host: this.host,
      /** Full federated identity string: @username:host (or just @username for local/bot) */
      federatedId: this.host ? `@${this.username}:${this.host}` : `@${this.username}`,
      avatar: this.avatar,
      bot: this.bot
    }
  }

  /** Age of the message in milliseconds. */
  get age() {
    return Date.now() - this.timestamp.getTime()
  }

  /** Whether the message was sent in a server (vs a DM). */
  get inServer() {
    return this.serverId !== null
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Reply to this message in the same channel.
   * @param {string|object} content  Text or full body object.
   * @param {object} [options]
   */
  async reply(content, options = {}) {
    const body = typeof content === 'string'
      ? { content, replyTo: this.id, ...options }
      : { ...content, replyTo: this.id }
    return this._client.rest.sendMessage(this.channelId, body)
  }

  /**
   * Edit this message (only works for messages sent by the bot).
   * @param {string|object} content
   */
  async edit(content) {
    return this._client.rest.editMessage(this.channelId, this.id, content)
  }

  /**
   * Delete this message.
   */
  async delete() {
    return this._client.rest.deleteMessage(this.channelId, this.id)
  }

  /**
   * Pin this message in its channel.
   */
  async pin() {
    return this._client.rest.pinMessage(this.channelId, this.id)
  }

  /**
   * Unpin this message from its channel.
   */
  async unpin() {
    return this._client.rest.unpinMessage(this.channelId, this.id)
  }

  /**
   * Add a reaction to this message.
   * @param {string} emoji
   */
  async react(emoji) {
    return this._client.rest.addReaction(this.channelId, this.id, emoji)
  }

  /**
   * Remove a reaction from this message.
   * @param {string} emoji
   */
  async unreact(emoji) {
    return this._client.rest.removeReaction(this.channelId, this.id, emoji)
  }

  /**
   * Send a typing indicator in this message's channel.
   */
  async startTyping() {
    return this._client.rest.sendTyping(this.channelId).catch(() => {})
  }

  // ---------------------------------------------------------------------------
  // Parsing helpers
  // ---------------------------------------------------------------------------

  startsWith(prefix) {
    return this.content.startsWith(prefix)
  }

  /**
   * Parse the message as a prefixed command.
   * @param {string} prefix
   * @returns {{ name: string, args: string[], raw: string } | null}
   */
  parseCommand(prefix) {
    if (!this.content.startsWith(prefix)) return null
    const withoutPrefix = this.content.slice(prefix.length).trim()
    const parts = withoutPrefix.split(/\s+/)
    return {
      name: parts[0]?.toLowerCase() || '',
      args: parts.slice(1),
      raw: withoutPrefix
    }
  }

  /**
   * Parse all @username:host mentions from the message content.
   * Returns an array of objects: { raw, username, host, federatedId }
   * @returns {Array<{raw: string, username: string, host: string|null, federatedId: string}>}
   */
  getMentions() {
    const results = []
    const re = /@([a-zA-Z0-9_\-.]+)(?::([a-zA-Z0-9_\-.]+))?/g
    let m
    while ((m = re.exec(this.content)) !== null) {
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

  /**
   * Whether this message mentions a specific user by their federated ID (@username:host)
   * or by bare username (for backward compat).
   * @param {string} federatedIdOrUsername  e.g. "@alice:example.com" or "alice"
   */
  mentionsUser(federatedIdOrUsername) {
    const needle = federatedIdOrUsername.startsWith('@')
      ? federatedIdOrUsername
      : `@${federatedIdOrUsername}`
    return this.content.includes(needle)
  }

  /** @deprecated Use mentionsUser() instead */
  mentionsById(userId) {
    return this.mentions?.users?.includes(userId) ?? this.content.includes(userId)
  }

  /** Whether the message has any embeds. */
  get hasEmbeds() {
    return this.embeds.length > 0
  }

  /** Whether the message has any attachments. */
  get hasAttachments() {
    return this.attachments.length > 0
  }

  toJSON() {
    return {
      id: this.id, channelId: this.channelId, serverId: this.serverId,
      userId: this.userId, username: this.username, host: this.host, avatar: this.avatar,
      content: this.content, embeds: this.embeds, attachments: this.attachments,
      mentions: this.mentions,
      bot: this.bot, pinned: this.pinned, replyTo: this.replyTo,
      timestamp: this.timestamp.toISOString(), edited: this.edited
    }
  }
}
