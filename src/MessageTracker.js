import { Message } from './Message.js'

function normalizeEmoji(raw) {
  if (!raw) return null
  if (typeof raw === 'string') return raw
  if (typeof raw.emoji === 'string') return raw.emoji
  if (typeof raw.name === 'string') return raw.name
  return null
}

export class MessageTracker {
  constructor(client, options = {}) {
    this._client = client
    this._maxMessages = Number.isFinite(options.maxMessages) ? options.maxMessages : 5000
    this.messages = new Map() // messageId -> Message
    this._channelIndex = new Map() // channelId -> messageId[] (oldest -> newest)
    this._reactions = new Map() // messageId -> Map<emoji, Set<userId>>
  }

  _touchChannelIndex(channelId, messageId) {
    if (!channelId || !messageId) return
    const list = this._channelIndex.get(channelId) || []
    if (!list.includes(messageId)) list.push(messageId)
    this._channelIndex.set(channelId, list)
  }

  _evictIfNeeded() {
    while (this.messages.size > this._maxMessages) {
      const oldest = this.messages.values().next().value
      if (!oldest) break
      this.deleteMessage(oldest.id, oldest.channelId)
    }
  }

  upsertMessage(input) {
    const message = input instanceof Message ? input : new Message(input, this._client)
    this.messages.set(message.id, message)
    this._touchChannelIndex(message.channelId, message.id)
    this._evictIfNeeded()
    return message
  }

  patchMessage(data = {}) {
    const id = data.id || data.messageId
    if (!id) return null

    const existing = this.messages.get(id)
    if (!existing) return this.upsertMessage(data)

    const merged = {
      ...existing.toJSON(),
      ...data,
      id,
      edited: true,
      timestamp: data.timestamp || existing.timestamp?.toISOString?.() || new Date().toISOString(),
    }
    return this.upsertMessage(merged)
  }

  deleteMessage(messageId, channelId = null) {
    if (!messageId) return
    const existing = this.messages.get(messageId)
    this.messages.delete(messageId)
    this._reactions.delete(messageId)

    const resolvedChannelId = channelId || existing?.channelId
    if (resolvedChannelId && this._channelIndex.has(resolvedChannelId)) {
      const next = this._channelIndex.get(resolvedChannelId).filter(id => id !== messageId)
      if (next.length > 0) this._channelIndex.set(resolvedChannelId, next)
      else this._channelIndex.delete(resolvedChannelId)
    }
  }

  applyReactionUpdate(data = {}) {
    const messageId = data.messageId || data.id
    const userId = data.userId || data.memberId || data.reactorId
    const emoji = normalizeEmoji(data.emoji || data.reaction || data)
    const action = data.action || data.type || 'add'
    if (!messageId || !emoji) return null

    const messageReactions = this._reactions.get(messageId) || new Map()
    const users = messageReactions.get(emoji) || new Set()

    if (action === 'remove') {
      if (userId) users.delete(userId)
      if (users.size === 0) messageReactions.delete(emoji)
      else messageReactions.set(emoji, users)
    } else {
      if (userId) users.add(userId)
      messageReactions.set(emoji, users)
    }

    if (messageReactions.size > 0) this._reactions.set(messageId, messageReactions)
    else this._reactions.delete(messageId)

    return { messageId, emoji, action, count: users.size, userIds: [...users] }
  }

  getMessage(messageId) {
    return this.messages.get(messageId) || null
  }

  getMessagesByChannel(channelId, { limit = 50, newestFirst = true } = {}) {
    const ids = this._channelIndex.get(channelId) || []
    const sliced = ids.slice(Math.max(0, ids.length - Math.max(1, limit)))
    const resolved = sliced.map(id => this.messages.get(id)).filter(Boolean)
    return newestFirst ? resolved.reverse() : resolved
  }

  getMessageContent(messageId) {
    return this.messages.get(messageId)?.content ?? null
  }

  getReactions(messageId) {
    const map = this._reactions.get(messageId)
    if (!map) return {}
    const out = {}
    for (const [emoji, users] of map.entries()) {
      out[emoji] = { count: users.size, userIds: [...users] }
    }
    return out
  }

  getReactionUsers(messageId, emoji) {
    return [...(this._reactions.get(messageId)?.get(emoji) || new Set())]
  }

  clear() {
    this.messages.clear()
    this._channelIndex.clear()
    this._reactions.clear()
  }
}
