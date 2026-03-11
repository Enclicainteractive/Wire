import { EventEmitter } from './EventEmitter.js'

function normalizeEmoji(input) {
  if (!input) return null
  if (typeof input === 'string') return input
  if (typeof input.emoji === 'string') return input.emoji
  if (typeof input.name === 'string') return input.name
  return null
}

export class WireCUI extends EventEmitter {
  constructor(client, { channelId, userId = null, consumeReaction = false, timeoutMs = 0 } = {}) {
    super()
    if (!client) throw new Error('WireCUI requires a client instance')
    if (!channelId) throw new Error('WireCUI requires a channelId')

    this.client = client
    this.channelId = channelId
    this.userId = userId
    this.consumeReaction = consumeReaction
    this.timeoutMs = timeoutMs

    this.messageId = null
    this.controls = new Map() // emoji -> actionId
    this._active = true
    this._timer = null

    this._onReactionAdd = this._onReactionAdd.bind(this)
    this._onMessageEdit = this._onMessageEdit.bind(this)
    this._onMessageDelete = this._onMessageDelete.bind(this)

    this.client.on('reactionAdd', this._onReactionAdd)
    this.client.on('messageEdit', this._onMessageEdit)
    this.client.on('messageDelete', this._onMessageDelete)

    if (this.timeoutMs > 0) {
      this._timer = setTimeout(() => this.close('timeout'), this.timeoutMs)
    }
  }

  async render({ content = '', embeds = [], controls = [] } = {}) {
    if (!this._active) throw new Error('WireCUI is closed')

    let message
    if (!this.messageId) {
      message = await this.client.send(this.channelId, { content, embeds })
      this.messageId = message?.id || message?.messageId || null
    } else {
      message = await this.client.rest.editMessage(this.channelId, this.messageId, { content, embeds })
    }

    this.controls.clear()
    for (const control of controls) {
      const emoji = normalizeEmoji(control.emoji || control)
      if (!emoji) continue
      const actionId = control.id || control.action || emoji
      this.controls.set(emoji, actionId)
      if (this.messageId) {
        await this.client.rest.addReaction(this.channelId, this.messageId, emoji).catch(() => {})
      }
    }

    this.emit('render', { messageId: this.messageId, controls: [...this.controls.entries()] })
    return message
  }

  async update(contentOrBody) {
    if (!this.messageId) throw new Error('Cannot update before first render')
    const body = typeof contentOrBody === 'string' ? { content: contentOrBody } : (contentOrBody || {})
    return this.client.rest.editMessage(this.channelId, this.messageId, body)
  }

  _onReactionAdd(data = {}) {
    if (!this._active || !this.messageId) return
    if ((data.messageId || data.id) !== this.messageId) return
    if (this.userId && data.userId !== this.userId) return

    const emoji = normalizeEmoji(data.emoji || data.reaction || data)
    if (!emoji || !this.controls.has(emoji)) return

    const action = this.controls.get(emoji)
    const payload = {
      action,
      emoji,
      userId: data.userId || null,
      channelId: data.channelId || this.channelId,
      messageId: this.messageId,
      raw: data,
    }

    if (this.consumeReaction && payload.userId) {
      this.client.rest.removeReaction(this.channelId, this.messageId, emoji).catch(() => {})
    }

    this.emit('action', payload)
  }

  _onMessageEdit(message) {
    if (!this._active || !this.messageId) return
    if ((message?.id || message?.messageId) !== this.messageId) return
    this.emit('externalEdit', message)
  }

  _onMessageDelete(data = {}) {
    if (!this._active || !this.messageId) return
    if ((data.messageId || data.id) !== this.messageId) return
    this.emit('deleted', data)
    this.close('deleted')
  }

  close(reason = 'manual') {
    if (!this._active) return
    this._active = false
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this.client.off('reactionAdd', this._onReactionAdd)
    this.client.off('messageEdit', this._onMessageEdit)
    this.client.off('messageDelete', this._onMessageDelete)
    this.emit('close', reason)
    this.removeAllListeners()
  }
}
