import { EventEmitter } from './EventEmitter.js'
import { createRequire } from 'module'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'

// @roamhq/wrtc is a native optional dependency — load via CJS require so that
// bots which don't use voice don't need it installed.
const require = createRequire(import.meta.url)

function loadWrtc() {
  try {
    return require('@roamhq/wrtc')
  } catch {
    throw new Error(
      '[Wire/Voice] @roamhq/wrtc is not installed. Run: npm install @roamhq/wrtc'
    )
  }
}

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.stunprotocol.org:3478' },
]

const PEER_CONFIG = {
  iceServers: ICE_SERVERS,
  bundlePolicy: 'max-compat',
  rtcpMuxPolicy: 'require',
}

// ---------------------------------------------------------------------------
// PCM audio pump — reads audio.mp3 via ffmpeg and pushes Int16 samples into
// an RTCAudioSource at the correct rate.
// ---------------------------------------------------------------------------

const SAMPLE_RATE    = 48000   // Hz  — matches WebRTC default
const CHANNELS       = 1       // mono
const BITS           = 16
const FRAME_DURATION = 20      // ms per push (20 ms = standard WebRTC ptime)
const FRAME_SAMPLES  = (SAMPLE_RATE * FRAME_DURATION) / 1000  // 960 samples
const FRAME_BYTES    = FRAME_SAMPLES * CHANNELS * (BITS / 8)  // 1920 bytes

class AudioPlayer extends EventEmitter {
  /**
   * @param {object} audioSource  RTCAudioSource from @roamhq/wrtc nonstandard
   * @param {string} filePath     Absolute path to the audio file
   * @param {boolean} loop        Whether to loop the file
   */
  constructor(audioSource, filePath, loop = false) {
    super()
    this._source    = audioSource
    this._filePath  = filePath
    this._loop      = loop
    this._ffmpeg    = null
    this._timer     = null
    this._buf       = Buffer.alloc(0)
    this._stopped   = false
    this._paused    = true   // hold the pump until unpaused (peers connected)
    this._ffmpegDone = false // track whether ffmpeg has finished
  }

  start() {
    this._stopped    = false
    this._paused     = true
    this._ffmpegDone = false
    this._spawnFfmpeg()
  }

  /**
   * Resume pumping — called by VoiceConnection once a peer WebRTC connection
   * reaches 'connected' state so audio isn't wasted before any peer is ready.
   */
  unpause() {
    this._paused = false
    // Start the pump timer if not already running
    if (!this._timer && !this._stopped) {
      this._timer = setInterval(() => this._pump(), FRAME_DURATION)
    }
  }

  _spawnFfmpeg() {
    if (this._stopped) return

    if (!fs.existsSync(this._filePath)) {
      this.emit('error', new Error(`Audio file not found: ${this._filePath}`))
      return
    }

    this._ffmpegDone = false

    // Decode the file to raw signed 16-bit LE PCM at 48 kHz mono
    this._ffmpeg = spawn('ffmpeg', [
      '-loglevel', 'quiet',
      '-i', this._filePath,
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
      'pipe:1',
    ])

    this._ffmpeg.stdout.on('data', (chunk) => {
      this._buf = Buffer.concat([this._buf, chunk])
    })

    this._ffmpeg.stderr.on('data', () => {}) // suppress

    this._ffmpeg.on('close', (code) => {
      this._ffmpeg    = null
      this._ffmpegDone = true
      if (!this._stopped && this._loop) {
        // Wait for the buffer to drain before re-encoding (avoids unbounded
        // memory growth).  Check every 20 ms; the paused-state check is
        // intentionally absent so restart works even if all peers left.
        const drain = setInterval(() => {
          if (this._stopped) { clearInterval(drain); return }
          if (this._buf.length < FRAME_BYTES) {
            clearInterval(drain)
            this._ffmpegDone = false
            this._spawnFfmpeg()
          }
        }, FRAME_DURATION)
      }
      // Non-loop finish is handled in _pump once the buffer is drained
    })

    this._ffmpeg.on('error', (err) => {
      this.emit('error', err)
    })
  }

  _pump() {
    if (this._stopped || this._paused) return

    if (this._buf.length >= FRAME_BYTES) {
      const frame   = this._buf.slice(0, FRAME_BYTES)
      this._buf     = this._buf.slice(FRAME_BYTES)
      const samples = new Int16Array(
        frame.buffer,
        frame.byteOffset,
        frame.byteLength / 2
      )

      try {
        this._source.onData({
          samples,
          sampleRate:     SAMPLE_RATE,
          bitsPerSample:  BITS,
          channelCount:   CHANNELS,
          numberOfFrames: FRAME_SAMPLES,
        })
      } catch {
        // RTCAudioSource may be gone if peer disconnected mid-play
      }
    } else if (this._ffmpegDone && !this._loop && !this._stopped) {
      // Buffer exhausted and ffmpeg is done — audio finished
      this.stop()
      this.emit('finish')
    }
  }

  stop() {
    this._stopped = true
    if (this._ffmpeg) {
      this._ffmpeg.kill('SIGKILL')
      this._ffmpeg = null
    }
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    this._buf = Buffer.alloc(0)
  }
}

// ---------------------------------------------------------------------------
// VoiceConnection — one instance per (serverId, channelId) pair
// ---------------------------------------------------------------------------

/**
 * Manages a bot's presence in a single VoltChat voice channel.
 *
 * Responsibilities:
 *  - Emit voice:join to the gateway and keep a heartbeat alive
 *  - Perform full WebRTC offer/answer/ICE negotiation with every peer
 *  - Stream an audio file (or any RTCAudioSource) to all peers
 *  - Clean up everything on leave()
 *
 * Events emitted:
 *  - 'ready'         — joined and WebRTC initialized
 *  - 'peerJoin'      (userId)
 *  - 'peerLeave'     (userId)
 *  - 'error'         (err)
 *  - 'finish'        — audio file finished (non-looping)
 *
 * @example
 * const vc = await client.joinVoice(serverId, channelId)
 * await vc.playFile('./audio.mp3')
 */
export class VoiceConnection extends EventEmitter {
  /**
   * @param {object} socket    The socket.io socket from Client
   * @param {string} botId     The bot's own user ID
   * @param {string} serverId
   * @param {string} channelId
   * @param {object} [options]
   * @param {boolean} [options.debug]
   */
  constructor(socket, botId, serverId, channelId, options = {}) {
    super()
    this._socket     = socket
    this._botId      = botId
    this._serverId   = serverId
    this._channelId  = channelId
    this._debug      = options.debug || false

    const wrtc = loadWrtc()
    this._RTCPeerConnection  = wrtc.RTCPeerConnection
    this._RTCSessionDescription = wrtc.RTCSessionDescription
    this._RTCIceCandidate    = wrtc.RTCIceCandidate
    const { RTCAudioSource } = wrtc.nonstandard

    // Audio source shared across all peers
    this._audioSource = new RTCAudioSource()
    this._audioTrack  = this._audioSource.createTrack()

    this._peers      = new Map()   // userId -> RTCPeerConnection
    this._player     = null
    this._heartbeat  = null
    this._joined     = false

    this._onParticipants  = this._onParticipants.bind(this)
    this._onUserJoined    = this._onUserJoined.bind(this)
    this._onUserLeft      = this._onUserLeft.bind(this)
    this._onOffer         = this._onOffer.bind(this)
    this._onAnswer        = this._onAnswer.bind(this)
    this._onIceCandidate  = this._onIceCandidate.bind(this)
  }

  _log(...args) {
    if (this._debug) console.log('[Wire/Voice]', ...args)
  }

  // ---------------------------------------------------------------------------
  // Join
  // ---------------------------------------------------------------------------

  /**
   * Join the voice channel. Called by Client.joinVoice().
   * @returns {Promise<VoiceConnection>}
   */
  join() {
    return new Promise((resolve, reject) => {
      if (this._joined) { resolve(this); return }

      this._registerSocketListeners()

      this._socket.emit('voice:join', {
        channelId: this._channelId,
        serverId:  this._serverId,
        peerId:    this._botId,
      })

      // Request existing participants
      this._socket.emit('voice:get-participants', { channelId: this._channelId })

      // Heartbeat every 5 s to satisfy the server's stale-user cleanup
      this._heartbeat = setInterval(() => {
        if (this._socket?.connected) {
          this._socket.emit('voice:heartbeat', { channelId: this._channelId })
        }
      }, 5000)

      this._joined = true
      this._log(`Joined channel ${this._channelId} in server ${this._serverId}`)
      this.emit('ready')
      resolve(this)
    })
  }

  // ---------------------------------------------------------------------------
  // Audio playback
  // ---------------------------------------------------------------------------

  /**
   * Stream an audio file to all peers in the channel.
   * Supports any format ffmpeg can decode (mp3, ogg, wav, flac, …).
   *
   * ffmpeg starts decoding immediately so the buffer is pre-filled, but the
   * PCM pump is held until at least one peer WebRTC connection reaches
   * 'connected' state.  This prevents audio from being silently discarded
   * before the WebRTC handshake completes.
   *
   * @param {string}  filePath  Path to the audio file
   * @param {object}  [opts]
   * @param {boolean} [opts.loop=false]   Loop the file until stop() is called
   * @returns {Promise<void>}  Resolves when playback starts (buffer filling)
   */
  playFile(filePath, { loop = false } = {}) {
    this.stopAudio()

    const resolved = path.resolve(filePath)
    this._player = new AudioPlayer(this._audioSource, resolved, loop)

    this._player.on('finish', () => {
      this._log('Audio finished:', resolved)
      this.emit('finish')
    })

    this._player.on('error', (err) => {
      this._log('Audio error:', err.message)
      this.emit('error', err)
    })

    this._player.start()
    this._log('Buffering audio (waiting for peer connection):', resolved)

    // If there's already a connected peer, start pumping immediately
    if (this._hasConnectedPeer()) {
      this._player.unpause()
      this._log('Peer already connected — starting pump immediately')
    }
    // Otherwise the pump will be unpaused by _onPeerConnected()

    return Promise.resolve()
  }

  /** Returns true if at least one RTCPeerConnection is in 'connected' state. */
  _hasConnectedPeer() {
    for (const pc of this._peers.values()) {
      if (pc.connectionState === 'connected') return true
    }
    return false
  }

  /** Called when a peer connection transitions to 'connected'. */
  _onPeerConnected() {
    if (this._player && this._player._paused) {
      this._log('Peer connected — unpausing audio pump')
      this._player.unpause()
    }
  }

  /** Stop any currently playing audio without leaving the channel. */
  stopAudio() {
    if (this._player) {
      this._player.stop()
      this._player = null
    }
  }

  // ---------------------------------------------------------------------------
  // Leave
  // ---------------------------------------------------------------------------

  /**
   * Leave the voice channel, stop audio, and tear down all peer connections.
   */
  leave() {
    this._log(`Leaving channel ${this._channelId}`)
    this.stopAudio()
    this._clearPeers()

    if (this._heartbeat) {
      clearInterval(this._heartbeat)
      this._heartbeat = null
    }

    this._deregisterSocketListeners()

    if (this._socket?.connected) {
      this._socket.emit('voice:leave', this._channelId)
    }

    // Release the audio track
    try { this._audioTrack.stop() } catch {}

    this._joined = false
    this.removeAllListeners()
  }

  // ---------------------------------------------------------------------------
  // WebRTC peer management
  // ---------------------------------------------------------------------------

  _createPeer(targetUserId) {
    if (this._peers.has(targetUserId)) return this._peers.get(targetUserId)

    this._log('Creating peer connection for', targetUserId)

    const pc = new this._RTCPeerConnection(PEER_CONFIG)
    this._peers.set(targetUserId, pc)

    // Add the shared audio track so this peer receives our audio
    pc.addTrack(this._audioTrack)

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && this._socket?.connected) {
        this._socket.emit('voice:ice-candidate', {
          to:        targetUserId,
          candidate,
          channelId: this._channelId,
        })
      }
    }

    pc.onconnectionstatechange = () => {
      this._log(`Peer ${targetUserId} connection state: ${pc.connectionState}`)
      if (pc.connectionState === 'connected') {
        this._onPeerConnected()
      }
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this._destroyPeer(targetUserId)
      }
    }

    return pc
  }

  async _initiateCall(targetUserId) {
    const pc = this._createPeer(targetUserId)
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this._socket.emit('voice:offer', {
        to:        targetUserId,
        offer:     pc.localDescription,
        channelId: this._channelId,
      })
      this._log('Sent offer to', targetUserId)
    } catch (err) {
      this._log('Failed to create offer for', targetUserId, ':', err.message)
      this.emit('error', err)
    }
  }

  _destroyPeer(userId) {
    const pc = this._peers.get(userId)
    if (pc) {
      try { pc.close() } catch {}
      this._peers.delete(userId)
    }
  }

  _clearPeers() {
    for (const [userId] of this._peers) this._destroyPeer(userId)
  }

  // ---------------------------------------------------------------------------
  // Socket event handlers
  // ---------------------------------------------------------------------------

  _registerSocketListeners() {
    this._socket.on('voice:participants',  this._onParticipants)
    this._socket.on('voice:user-joined',   this._onUserJoined)
    this._socket.on('voice:user-left',     this._onUserLeft)
    this._socket.on('voice:offer',         this._onOffer)
    this._socket.on('voice:answer',        this._onAnswer)
    this._socket.on('voice:ice-candidate', this._onIceCandidate)
  }

  _deregisterSocketListeners() {
    this._socket.off('voice:participants',  this._onParticipants)
    this._socket.off('voice:user-joined',   this._onUserJoined)
    this._socket.off('voice:user-left',     this._onUserLeft)
    this._socket.off('voice:offer',         this._onOffer)
    this._socket.off('voice:answer',        this._onAnswer)
    this._socket.off('voice:ice-candidate', this._onIceCandidate)
  }

  _onParticipants({ channelId, participants }) {
    if (channelId !== this._channelId) return
    this._log('Existing participants:', participants?.map(p => p.id))
    for (const p of (participants || [])) {
      if (p.id !== this._botId && !this._peers.has(p.id)) {
        setTimeout(() => this._initiateCall(p.id), 200)
      }
    }
  }

  _onUserJoined(userInfo) {
    const userId = userInfo.id || userInfo.userId
    if (!userId || userId === this._botId) return
    this._log('User joined voice:', userId)
    this.emit('peerJoin', userId)
    // Give the server a moment to register the new peer before offering
    setTimeout(() => this._initiateCall(userId), 500)
  }

  _onUserLeft({ userId }) {
    if (!userId || userId === this._botId) return
    this._log('User left voice:', userId)
    this._destroyPeer(userId)
    this.emit('peerLeave', userId)
  }

  async _onOffer({ from, offer, channelId }) {
    if (channelId !== this._channelId) return
    this._log('Received offer from', from)
    const pc = this._createPeer(from)
    try {
      await pc.setRemoteDescription(new this._RTCSessionDescription(offer))
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      this._socket.emit('voice:answer', {
        to:        from,
        answer:    pc.localDescription,
        channelId: this._channelId,
      })
      this._log('Sent answer to', from)
    } catch (err) {
      this._log('Failed to handle offer from', from, ':', err.message)
      this.emit('error', err)
    }
  }

  async _onAnswer({ from, answer }) {
    const pc = this._peers.get(from)
    if (!pc) return
    if (pc.signalingState === 'stable') return
    try {
      await pc.setRemoteDescription(new this._RTCSessionDescription(answer))
      this._log('Set remote answer from', from)
    } catch (err) {
      this._log('Failed to set answer from', from, ':', err.message)
    }
  }

  async _onIceCandidate({ from, candidate, channelId }) {
    if (channelId !== this._channelId) return
    const pc = this._peers.get(from)
    if (!pc || !candidate) return
    try {
      await pc.addIceCandidate(new this._RTCIceCandidate(candidate))
    } catch (err) {
      this._log('Failed to add ICE candidate from', from, ':', err.message)
    }
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /** The channel ID this connection is for. */
  get channelId() { return this._channelId }

  /** The server ID this connection is for. */
  get serverId() { return this._serverId }

  /** Whether this connection is active. */
  get connected() { return this._joined }

  /** Number of active peer connections. */
  get peerCount() { return this._peers.size }
}
