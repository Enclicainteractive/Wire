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

// ---------------------------------------------------------------------------
// ICE server configuration
// Public STUN servers + optional TURN (set via env or passed in options)
// ---------------------------------------------------------------------------

function buildIceServers(extraServers = []) {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.stunprotocol.org:3478' },
  ]

  // TURN server from environment (self-hosted)
  const turnUrl  = process.env.TURN_URL  || null
  const turnUser = process.env.TURN_USER || null
  const turnPass = process.env.TURN_PASS || null
  if (turnUrl && turnUser && turnPass) {
    servers.push({ urls: turnUrl, username: turnUser, credential: turnPass })
    // Also add TURNS (TLS) variant
    const turnsUrl = turnUrl.replace(/^turn:/, 'turns:')
    if (turnsUrl !== turnUrl) {
      servers.push({ urls: turnsUrl, username: turnUser, credential: turnPass })
    }
  }

  return [...servers, ...extraServers]
}

// ---------------------------------------------------------------------------
// PCM audio pump
// ---------------------------------------------------------------------------

const SAMPLE_RATE    = 48000
const CHANNELS       = 1
const BITS           = 16
const FRAME_DURATION = 20
const FRAME_SAMPLES  = (SAMPLE_RATE * FRAME_DURATION) / 1000  // 960
const FRAME_BYTES    = FRAME_SAMPLES * CHANNELS * (BITS / 8)  // 1920

class AudioPlayer extends EventEmitter {
  constructor(audioSource, filePath, loop = false) {
    super()
    this._source     = audioSource
    this._filePath   = filePath
    this._loop       = loop
    this._ffmpeg     = null
    this._timer      = null
    this._buf        = Buffer.alloc(0)
    this._stopped    = false
    this._paused     = true
    this._ffmpegDone = false
  }

  start() {
    this._stopped    = false
    this._paused     = true
    this._ffmpegDone = false
    this._spawnFfmpeg()
  }

  unpause() {
    this._paused = false
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
    this._ffmpeg.stderr.on('data', () => {})
    this._ffmpeg.on('close', () => {
      this._ffmpeg    = null
      this._ffmpegDone = true
      if (!this._stopped && this._loop) {
        const drain = setInterval(() => {
          if (this._stopped) { clearInterval(drain); return }
          if (this._buf.length < FRAME_BYTES) {
            clearInterval(drain)
            this._ffmpegDone = false
            this._spawnFfmpeg()
          }
        }, FRAME_DURATION)
      }
    })
    this._ffmpeg.on('error', (err) => this.emit('error', err))
  }

  _pump() {
    if (this._stopped || this._paused) return
    if (this._buf.length >= FRAME_BYTES) {
      const frame   = this._buf.slice(0, FRAME_BYTES)
      this._buf     = this._buf.slice(FRAME_BYTES)
      const samples = new Int16Array(frame.buffer, frame.byteOffset, frame.byteLength / 2)
      try {
        this._source.onData({
          samples,
          sampleRate:     SAMPLE_RATE,
          bitsPerSample:  BITS,
          channelCount:   CHANNELS,
          numberOfFrames: FRAME_SAMPLES,
        })
      } catch { /* peer disconnected */ }
    } else if (this._ffmpegDone && !this._loop && !this._stopped) {
      this.stop()
      this.emit('finish')
    }
  }

  stop() {
    this._stopped = true
    if (this._ffmpeg) { try { this._ffmpeg.kill('SIGKILL') } catch {} ; this._ffmpeg = null }
    if (this._timer)  { clearInterval(this._timer); this._timer = null }
    this._buf = Buffer.alloc(0)
  }
}

// ---------------------------------------------------------------------------
// PeerState — per-peer negotiation state machine
// Implements RFC 8829 "perfect negotiation" to resolve offer collisions.
// ---------------------------------------------------------------------------

class PeerState {
  /**
   * @param {string}  peerId   Remote user ID
   * @param {string}  localId  Our own bot ID
   * @param {boolean} polite   Polite side loses in a collision (lower ID = polite)
   */
  constructor(peerId, localId, polite) {
    this.peerId          = peerId
    this.polite          = polite
    this.pc              = null
    this.makingOffer     = false   // true while createOffer→setLocalDescription is in flight
    this.ignoreOffer     = false   // set when impolite and collision detected
    this.pendingCandidates = []    // buffered ICE candidates before remoteDesc is set
    this.remoteDescSet   = false
  }
}

// ---------------------------------------------------------------------------
// VoiceConnection
// ---------------------------------------------------------------------------

export class VoiceConnection extends EventEmitter {
  /**
   * @param {object} socket
   * @param {string} botId
   * @param {string} serverId
   * @param {string} channelId
   * @param {object} [options]
   * @param {boolean} [options.debug]
   * @param {Array}   [options.iceServers]  Additional ICE servers from the Voltage server
   */
  constructor(socket, botId, serverId, channelId, options = {}) {
    super()
    this._socket     = socket
    this._botId      = botId
    this._serverId   = serverId
    this._channelId  = channelId
    this._debug      = options.debug || false
    this._iceServers = buildIceServers(options.iceServers || [])

    const wrtc = loadWrtc()
    this._RTCPeerConnection     = wrtc.RTCPeerConnection
    this._RTCSessionDescription = wrtc.RTCSessionDescription
    this._RTCIceCandidate       = wrtc.RTCIceCandidate
    this._MediaStream           = wrtc.MediaStream
    const { RTCAudioSource }    = wrtc.nonstandard

    this._audioSource = new RTCAudioSource()
    this._audioTrack  = this._audioSource.createTrack()
    this._audioTrack.enabled = true
    // Wrap the track in a MediaStream so browsers receive event.streams[0]
    // when this track arrives via ontrack — without this, event.streams is empty
    this._audioStream = new this._MediaStream([this._audioTrack])

    /** @type {Map<string, PeerState>} */
    this._peers     = new Map()
    this._player    = null
    this._heartbeat = null
    this._joined    = false

    // Bind handlers once so we can remove them later
    this._onParticipants  = this._onParticipants.bind(this)
    this._onUserJoined    = this._onUserJoined.bind(this)
    this._onUserLeft      = this._onUserLeft.bind(this)
    this._onOffer         = this._onOffer.bind(this)
    this._onAnswer        = this._onAnswer.bind(this)
    this._onIceCandidate  = this._onIceCandidate.bind(this)
  }

  _log(...args) { if (this._debug) console.log('[Wire/Voice]', ...args) }

  // ---------------------------------------------------------------------------
  // Join
  // ---------------------------------------------------------------------------

  join() {
    return new Promise((resolve) => {
      if (this._joined) { resolve(this); return }

      this._registerSocketListeners()

      this._socket.emit('voice:join', {
        channelId: this._channelId,
        serverId:  this._serverId,
        peerId:    this._botId,
      })
      // NOTE: voice:join already triggers a voice:participants response from the server.
      // Do NOT emit voice:get-participants here — it would cause a second participants
      // response which triggers duplicate _offerTo calls, leading to the m-line error.

      // Heartbeat every 5 s
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

  playFile(filePath, { loop = false } = {}) {
    this.stopAudio()
    const resolved = path.resolve(filePath)
    this._player = new AudioPlayer(this._audioSource, resolved, loop)
    this._player.on('finish', () => { this._log('Audio finished:', resolved); this.emit('finish') })
    this._player.on('error',  (err) => { this._log('Audio error:', err.message); this.emit('error', err) })
    this._player.start()
    this._log('Playing:', resolved)
    if (this._hasConnectedPeer()) {
      this._player.unpause()
    } else {
      // Hard fallback: if wrtc never fires 'connected' and there are peers,
      // start the pump after 3 s so audio doesn't silently hang forever.
      const player = this._player
      setTimeout(() => {
        if (player._paused && !player._stopped && this._peers.size > 0) {
          this._log('Fallback: unpausing audio pump after 3 s (wrtc connection state unreliable)')
          player.unpause()
        }
      }, 3000)
    }
    return Promise.resolve()
  }

  _hasConnectedPeer() {
    for (const ps of this._peers.values()) {
      if (ps.pc?.connectionState === 'connected') return true
    }
    return false
  }

  _onPeerConnected() {
    if (this._player?._paused) {
      this._log('Peer connected — starting audio pump')
      this._player.unpause()
    }
  }

  stopAudio() {
    if (this._player) { this._player.stop(); this._player = null }
  }

  // ---------------------------------------------------------------------------
  // Leave
  // ---------------------------------------------------------------------------

  leave() {
    this._log(`Leaving channel ${this._channelId}`)
    this.stopAudio()
    this._clearAllPeers()
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null }
    this._deregisterSocketListeners()
    if (this._socket?.connected) this._socket.emit('voice:leave', this._channelId)
    try { this._audioTrack.stop() } catch {}
    try { this._audioStream?.getTracks().forEach(t => t.stop()) } catch {}
    this._joined = false
    this.removeAllListeners()
  }

  // ---------------------------------------------------------------------------
  // Perfect negotiation peer management
  // ---------------------------------------------------------------------------

  /**
   * Determine polite role: the peer with the lexicographically lower ID is polite.
   * This is deterministic for both sides given the same two IDs.
   */
  _isPolite(remoteId) {
    return this._botId < remoteId
  }

  /**
   * Get or create a PeerState for a remote peer.
   * If the peer already exists but its RTCPeerConnection is closed/failed,
   * a fresh RTCPeerConnection is created without altering the polite role.
   */
  _getOrCreatePeerState(remoteId) {
    let ps = this._peers.get(remoteId)

    if (!ps) {
      ps = new PeerState(remoteId, this._botId, this._isPolite(remoteId))
      this._peers.set(remoteId, ps)
    }

    // Build or rebuild the RTCPeerConnection if needed
    if (!ps.pc || ps.pc.connectionState === 'closed' || ps.pc.connectionState === 'failed') {
      if (ps.pc) {
        try { ps.pc.close() } catch {}
      }
      ps.makingOffer       = false
      ps.ignoreOffer       = false
      ps.pendingCandidates = []
      ps.remoteDescSet     = false
      ps.pc = this._buildPeerConnection(ps)
    }

    return ps
  }

  _buildPeerConnection(ps) {
    const pc = new this._RTCPeerConnection({
      iceServers:   this._iceServers,
      bundlePolicy: 'max-bundle',      // bundle all m-lines — fixes m-line order issues
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 10,        // pre-gather candidates
    })

    // Add audio track associated with our stream so the remote peer receives
    // event.streams[0] in their ontrack handler (required for Audio.srcObject)
    pc.addTrack(this._audioTrack, this._audioStream)

    // Send local ICE candidates to the remote peer
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || !this._socket?.connected) return
      this._socket.emit('voice:ice-candidate', {
        to:        ps.peerId,
        candidate: candidate.toJSON(),
        channelId: this._channelId,
      })
    }

    pc.onicegatheringstatechange = () => {
      this._log(`ICE gathering state for ${ps.peerId}: ${pc.iceGatheringState}`)
    }

    pc.oniceconnectionstatechange = () => {
      this._log(`ICE connection state for ${ps.peerId}: ${pc.iceConnectionState}`)
      // Restart ICE if it fails (handles network changes)
      if (pc.iceConnectionState === 'failed') {
        this._log(`ICE failed for ${ps.peerId} — attempting ICE restart`)
        this._restartIce(ps)
      }
    }

    pc.onconnectionstatechange = () => {
      this._log(`Peer ${ps.peerId} connection state: ${pc.connectionState}`)
      if (pc.connectionState === 'connected') {
        this._onPeerConnected()
        this.emit('peerJoin', ps.peerId)
      }
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this._destroyPeerState(ps.peerId)
      }
    }

    // Perfect negotiation: handle the onnegotiationneeded event.
    // Guard against re-entry: if we're already making an offer, skip this event —
    // the in-flight negotiation already covers the pending changes.
    pc.onnegotiationneeded = async () => {
      if (ps.makingOffer) {
        this._log(`Skipping onnegotiationneeded for ${ps.peerId} — offer already in flight`)
        return
      }
      // Also skip if we're not in stable state (e.g. waiting for an answer)
      if (pc.signalingState !== 'stable') {
        this._log(`Skipping onnegotiationneeded for ${ps.peerId} — signalingState: ${pc.signalingState}`)
        return
      }
      try {
        ps.makingOffer = true
        // createOffer + setLocalDescription in one call (modern API)
        const offer = await pc.createOffer()
        // Re-check state — may have changed while createOffer was async
        if (pc.signalingState !== 'stable') {
          this._log(`Aborting offer for ${ps.peerId} — state changed to ${pc.signalingState}`)
          return
        }
        await pc.setLocalDescription(offer)
        this._socket.emit('voice:offer', {
          to:        ps.peerId,
          offer:     pc.localDescription,
          channelId: this._channelId,
        })
        this._log(`Sent offer to ${ps.peerId}`)
      } catch (err) {
        this._log(`onnegotiationneeded error for ${ps.peerId}:`, err.message)
      } finally {
        ps.makingOffer = false
      }
    }

    return pc
  }

  async _restartIce(ps) {
    if (!ps.pc || ps.pc.signalingState !== 'stable') return
    try {
      ps.makingOffer = true
      await ps.pc.setLocalDescription(await ps.pc.createOffer({ iceRestart: true }))
      this._socket.emit('voice:offer', {
        to:        ps.peerId,
        offer:     ps.pc.localDescription,
        channelId: this._channelId,
      })
      this._log(`Sent ICE restart offer to ${ps.peerId}`)
    } catch (err) {
      this._log(`ICE restart failed for ${ps.peerId}:`, err.message)
    } finally {
      ps.makingOffer = false
    }
  }

  _destroyPeerState(remoteId) {
    const ps = this._peers.get(remoteId)
    if (!ps) return
    if (ps.pc) { try { ps.pc.close() } catch {} }
    this._peers.delete(remoteId)
  }

  _clearAllPeers() {
    for (const remoteId of [...this._peers.keys()]) {
      this._destroyPeerState(remoteId)
    }
  }

  // ---------------------------------------------------------------------------
  // Socket listeners
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

  // ---------------------------------------------------------------------------
  // Socket event handlers
  // ---------------------------------------------------------------------------

  _onParticipants({ channelId, participants }) {
    if (channelId !== this._channelId) return
    this._log('Existing participants:', participants?.map(p => p.id || p))
    for (const p of (participants || [])) {
      const pid = p.id || p
      if (!pid || pid === this._botId) continue
      // Stagger offers to avoid simultaneous connection races
      const delay = 200 + Math.random() * 300
      setTimeout(() => this._offerTo(pid), delay)
    }
  }

  _onUserJoined(userInfo) {
    const userId = userInfo?.id || userInfo?.userId
    if (!userId || userId === this._botId) return
    this._log('User joined voice:', userId)
    // Slight delay so the other side has registered before we offer
    setTimeout(() => this._offerTo(userId), 400 + Math.random() * 200)
  }

  _onUserLeft(data) {
    const userId = data?.userId || data?.id
    if (!userId || userId === this._botId) return
    this._log('User left voice:', userId)
    this._destroyPeerState(userId)
    this.emit('peerLeave', userId)
  }

  /**
   * Initiate a call to a remote peer.
   * Creates the RTCPeerConnection which triggers onnegotiationneeded → offer.
   * Guards against duplicate calls while negotiation is already in progress.
   */
  _offerTo(remoteId) {
    const existing = this._peers.get(remoteId)
    if (existing) {
      const state = existing.pc?.connectionState
      // Already connected or actively negotiating — do nothing
      if (state === 'connected' || state === 'connecting') return
      if (existing.makingOffer) {
        this._log(`_offerTo ${remoteId} skipped — offer already in flight`)
        return
      }
    }
    this._log('Creating peer connection for', remoteId)
    this._getOrCreatePeerState(remoteId)
    // onnegotiationneeded fires automatically after addTrack in _buildPeerConnection
  }

  /**
   * Handle an incoming offer — implements the "polite peer" rollback logic
   * from RFC 8829 perfect negotiation.
   */
  async _onOffer({ from, offer, channelId }) {
    if (channelId !== this._channelId) return
    this._log(`Received offer from ${from}`)

    const ps = this._getOrCreatePeerState(from)
    const pc = ps.pc

    const offerCollision = ps.makingOffer || pc.signalingState !== 'stable'

    // Impolite peer ignores colliding offers
    ps.ignoreOffer = !ps.polite && offerCollision
    if (ps.ignoreOffer) {
      this._log(`Ignoring colliding offer from ${from} (impolite)`)
      return
    }

    try {
      // Polite peer: rollback local offer if needed
      if (offerCollision) {
        this._log(`Polite peer rolling back for ${from}`)
        await pc.setLocalDescription({ type: 'rollback' })
        ps.makingOffer = false
      }

      await pc.setRemoteDescription(new this._RTCSessionDescription(offer))
      ps.remoteDescSet = true

      // Flush any buffered ICE candidates
      await this._flushCandidates(ps)

      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)

      this._socket.emit('voice:answer', {
        to:        from,
        answer:    pc.localDescription,
        channelId: this._channelId,
      })
      this._log(`Sent answer to ${from}`)

      // Poll for connected state — wrtc may not fire onconnectionstatechange
      this._pollForConnected(ps)
    } catch (err) {
      this._log(`Failed to handle offer from ${from}:`, err.message)
      this.emit('error', err)
    }
  }

  async _onAnswer({ from, answer, channelId }) {
    if (channelId && channelId !== this._channelId) return
    const ps = this._peers.get(from)
    if (!ps?.pc) return
    if (ps.pc.signalingState === 'stable') return  // already stable, ignore duplicate

    try {
      await ps.pc.setRemoteDescription(new this._RTCSessionDescription(answer))
      ps.remoteDescSet = true
      // Clear ignoreOffer — the polite peer accepted our offer and sent a valid
      // answer, so from this point on we must process their ICE candidates.
      ps.ignoreOffer = false
      this._log(`Set remote answer from ${from}`)
      // Flush buffered candidates now that remote desc is set
      await this._flushCandidates(ps)

      // @roamhq/wrtc sometimes does not fire onconnectionstatechange for the
      // 'connected' transition.  Poll the state for up to 5 s after setting the
      // remote answer so audio is unpaused even when the event is missed.
      this._pollForConnected(ps)
    } catch (err) {
      // Ignore answers for ignored offers
      if (!ps.ignoreOffer) {
        this._log(`Failed to set answer from ${from}:`, err.message)
      }
    }
  }

  /**
   * Poll the RTCPeerConnection every 250 ms for up to 5 s waiting for
   * connectionState to reach 'connected'.  Calls _onPeerConnected() as soon
   * as it does.  This works around @roamhq/wrtc not always firing
   * onconnectionstatechange for the 'connected' transition.
   */
  _pollForConnected(ps, attempts = 0) {
    const MAX = 20  // 20 × 250 ms = 5 s
    if (attempts >= MAX) return
    setTimeout(() => {
      if (!ps.pc) return
      const state = ps.pc.connectionState
      this._log(`Poll connectionState for ${ps.peerId}: ${state} (attempt ${attempts + 1})`)
      if (state === 'connected') {
        this._onPeerConnected()
        this.emit('peerJoin', ps.peerId)
      } else if (state === 'failed' || state === 'closed') {
        // Give up
      } else {
        this._pollForConnected(ps, attempts + 1)
      }
    }, 250)
  }

  async _onIceCandidate({ from, candidate, channelId }) {
    if (channelId && channelId !== this._channelId) return
    if (!from || !candidate) return

    const ps = this._peers.get(from)
    if (!ps?.pc) {
      // Peer state doesn't exist yet — create it and buffer the candidate
      const newPs = this._getOrCreatePeerState(from)
      newPs.pendingCandidates.push(candidate)
      return
    }

    if (ps.ignoreOffer) return  // don't process candidates for ignored offers

    if (!ps.remoteDescSet) {
      // Buffer the candidate — will be flushed after setRemoteDescription
      ps.pendingCandidates.push(candidate)
      return
    }

    await this._addIceCandidate(ps, candidate)
  }

  async _addIceCandidate(ps, candidateInit) {
    try {
      await ps.pc.addIceCandidate(new this._RTCIceCandidate(candidateInit))
    } catch (err) {
      // Ignore candidates for connections that got rolled back
      if (!ps.ignoreOffer) {
        this._log(`Failed to add ICE candidate from ${ps.peerId}:`, err.message)
      }
    }
  }

  /** Apply all buffered ICE candidates now that remote desc is set. */
  async _flushCandidates(ps) {
    const candidates = ps.pendingCandidates.splice(0)
    for (const c of candidates) {
      await this._addIceCandidate(ps, c)
    }
    if (candidates.length > 0) {
      this._log(`Flushed ${candidates.length} buffered ICE candidate(s) for ${ps.peerId}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get channelId()  { return this._channelId }
  get serverId()   { return this._serverId }
  get connected()  { return this._joined }
  get peerCount()  { return this._peers.size }
}
