export class Message {
  constructor(data, client) {
    this.id = data.id
    this.channelId = data.channelId
    this.serverId = data.serverId || null
    this.userId = data.userId
    this.username = data.username
    this.avatar = data.avatar || null
    this.content = data.content || ''
    this.embeds = data.embeds || []
    this.attachments = data.attachments || []
    this.bot = data.bot || false
    this.timestamp = data.timestamp ? new Date(data.timestamp) : new Date()
    this.edited = data.edited || false
    this._client = client
  }

  get author() {
    return {
      id: this.userId,
      username: this.username,
      avatar: this.avatar,
      bot: this.bot
    }
  }

  async reply(content, options = {}) {
    const body = typeof content === 'string'
      ? { content, replyTo: this.id, ...options }
      : { ...content, replyTo: this.id }
    return this._client.rest.sendMessage(this.channelId, body)
  }

  async react(emoji) {
    return this._client.rest.addReaction(this.channelId, this.id, emoji)
  }

  startsWith(prefix) {
    return this.content.startsWith(prefix)
  }

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
}
