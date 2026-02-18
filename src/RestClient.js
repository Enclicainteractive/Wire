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
    if (body && method !== 'GET') {
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

  // Bot self info
  async getMe() {
    return this._request('GET', '/api/bots/api/me')
  }

  // Gateway info
  async getGateway() {
    return this._request('GET', '/api/bots/api/gateway')
  }

  // Send a message to a channel
  async sendMessage(channelId, content, options = {}) {
    const body = typeof content === 'string'
      ? { content, ...options }
      : content
    return this._request('POST', `/api/bots/api/channels/${channelId}/messages`, body)
  }

  // Register slash commands
  async registerCommands(commands) {
    return this._request('PUT', '/api/bots/api/commands', { commands })
  }

  // Update bot status
  async setStatus(status) {
    return this._request('PUT', '/api/bots/api/status', { status })
  }

  // Get server members
  async getServerMembers(serverId) {
    return this._request('GET', `/api/bots/api/servers/${serverId}/members`)
  }

  // Add reaction
  async addReaction(channelId, messageId, emoji) {
    return this._request('POST', `/api/bots/api/channels/${channelId}/messages/${messageId}/reactions`, { emoji })
  }
}
