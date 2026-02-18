import { createServer } from 'http'
import crypto from 'crypto'
import { EventEmitter } from './EventEmitter.js'

export class WebhookServer extends EventEmitter {
  constructor(options = {}) {
    super()
    this.port = options.port || 3100
    this.secret = options.secret
    this.path = options.path || '/webhook'
    this._server = null
  }

  _verify(body, signature) {
    if (!this.secret) return true
    const expected = crypto.createHmac('sha256', this.secret).update(body).digest('hex')
    try {
      return crypto.timingSafeEqual(Buffer.from(signature || ''), Buffer.from(expected))
    } catch {
      return false
    }
  }

  start() {
    return new Promise((resolve) => {
      this._server = createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== this.path) {
          res.writeHead(404)
          res.end()
          return
        }

        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          const signature = req.headers['x-volt-signature']
          if (!this._verify(body, signature)) {
            res.writeHead(401)
            res.end('Invalid signature')
            return
          }

          try {
            const payload = JSON.parse(body)
            const event = req.headers['x-volt-event'] || payload.event
            this.emit(event, payload.data || payload)
            this.emit('*', event, payload.data || payload)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"ok":true}')
          } catch (err) {
            res.writeHead(400)
            res.end('Invalid JSON')
          }
        })
      })

      this._server.listen(this.port, () => {
        console.log(`[Wire] Webhook server listening on port ${this.port}`)
        resolve(this._server)
      })
    })
  }

  stop() {
    return new Promise((resolve) => {
      if (this._server) {
        this._server.close(resolve)
      } else {
        resolve()
      }
    })
  }
}
