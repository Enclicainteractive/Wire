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
const FRAME_DURATION = 10  // 10ms — wrtc RTCAudioSource expects 480 samples
const FRAME_SAMPLES  = (SAMPLE_RATE * FRAME_DURATION) / 1000  // 480
const FRAME_BYTES    = FRAME_SAMPLES * CHANNELS * (BITS / 8)  // 960

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
    if (!this._paused) return   // already running — idempotent
    console.log(`[Wire/Voice] AudioPlayer unpausing — buf: ${this._buf.length} bytes, ffmpegDone: ${this._ffmpegDone}`)
    this._paused = false
    if (!this._timer && !this._stopped) {
      this._timer = setInterval(() => this._pump(), FRAME_DURATION)
      console.log(`[Wire/Voice] AudioPlayer pump timer started (interval: ${FRAME_DURATION}ms)`)
    }
  }

  _spawnFfmpeg() {
    if (this._stopped) return
    if (!fs.existsSync(this._filePath)) {
      this.emit('error', new Error(`Audio file not found: ${this._filePath}`))
      return
    }
    this._ffmpegDone = false
    this._bytesReceived = 0
    
    // Add options for better streaming stability with multiple peers
    // -fflags +nobuffer: reduce buffering latency
    // -flags low_delay: prioritize low latency
    // -probesize 32: smaller probe size for faster start
    // -analyzeduration 0: don't analyze stream duration
    this._ffmpeg = spawn('ffmpeg', [
      '-loglevel', 'warning',
      '-fflags', '+nobuffer',
      '-flags', 'low_delay',
      '-probesize', '32',
      '-analyzeduration', '0',
      '-i', this._filePath,
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
      '-af', 'aresample=async=1:min_comp=0.001:first_pts=0',  // Async resampling for stability
      'pipe:1',
    ])
    this._ffmpeg.stdout.on('data', (chunk) => {
      this._buf = Buffer.concat([this._buf, chunk])
      this._bytesReceived += chunk.length
    })
    this._ffmpeg.stderr.on('data', (d) => {
      const msg = d.toString().trim()
      if (msg) console.warn('[Wire/Voice] ffmpeg:', msg)
    })
    this._ffmpeg.on('close', (code) => {
      console.log(`[Wire/Voice] ffmpeg closed (code=${code}) bytesReceived=${this._bytesReceived}`)
      this._ffmpeg    = null
      this._ffmpegDone = true
      if (this._bytesReceived === 0) {
        this.emit('error', new Error('ffmpeg produced no PCM output — check audio file and codec'))
        return
      }
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
    this._ffmpeg.on('error', (err) => {
      console.error('[Wire/Voice] ffmpeg spawn error:', err.message)
      this.emit('error', err)
    })
  }

  _pump() {
    if (this._stopped || this._paused) {
      if (this._framesSent && this._framesSent < 10) {
        console.log(`[Wire/Voice] Pump skipped — stopped=${this._stopped}, paused=${this._paused}`)
      }
      return
    }
    
    // For multi-peer stability, ensure we have enough buffered data
    // to prevent underruns when network conditions vary between peers
    const minBufferFrames = 5  // Minimum 5 frames (50ms) before pumping
    const minBufferBytes = minBufferFrames * FRAME_BYTES
    
    if (this._buf.length >= FRAME_BYTES) {
      // Only warn about low buffer occasionally to avoid spam
      if (this._buf.length < minBufferBytes && this._framesSent && this._framesSent % 100 === 0) {
        console.log(`[Wire/Voice] Low buffer warning: ${this._buf.length} bytes remaining`)
      }
      
      // Extract frame data and create a proper Int16Array copy
      // We must copy because frame.buffer may be the entire pool, not just our slice
      const frameData = Buffer.alloc(FRAME_BYTES)
      this._buf.copy(frameData, 0, 0, FRAME_BYTES)
      this._buf = this._buf.slice(FRAME_BYTES)
      const samples = new Int16Array(frameData.buffer, frameData.byteOffset, FRAME_SAMPLES)
      try {
        this._source.onData({
          samples,
          sampleRate:     SAMPLE_RATE,
          bitsPerSample:  BITS,
          channelCount:   CHANNELS,
          numberOfFrames: FRAME_SAMPLES,
        })
        this._framesSent = (this._framesSent || 0) + 1
        if (this._framesSent === 1) {
          console.log(`[Wire/Voice] PCM pump — FIRST FRAME SENT! Total frames: ${this._framesSent}, buf remaining: ${this._buf.length}`)
        } else if (this._framesSent % 250 === 0) {
          console.log(`[Wire/Voice] PCM pump — frames sent: ${this._framesSent}, buf remaining: ${this._buf.length}`)
        }
      } catch (err) {
        console.error('[Wire/Voice] Error sending audio frame:', err.message)
      }
    } else if (this._buf.length > 0) {
      // Partial frame — pad with silence so the last chunk still gets sent
      const silence = Buffer.alloc(FRAME_BYTES - this._buf.length, 0)
      this._buf = Buffer.concat([this._buf, silence])
    } else if (this._ffmpegDone && !this._loop && !this._stopped) {
      console.log(`[Wire/Voice] Audio finished — total frames sent: ${this._framesSent || 0}`)
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

    // Multi-peer connection management with tiered scaling for up to 100 peers
    this._connectionQueue = []      // Queue of peer IDs waiting to connect
    this._isConnecting = false      // Whether currently processing queue
    this._activeNegotiations = 0    // Current active negotiations
    this._connectionCooldowns = new Map()  // peerId -> timestamp of last connection attempt
    this._lastBatchProcessTime = 0  // For batch processing
    
    // Tiered configuration based on participant count
    this._tierConfig = {
      small: { maxPeers: 10, concurrent: 2, cooldown: 1000, staggerBase: 300, staggerPerPeer: 200 },
      medium: { maxPeers: 25, concurrent: 2, cooldown: 1500, staggerBase: 800, staggerPerPeer: 400 },
      large: { maxPeers: 50, concurrent: 1, cooldown: 2000, staggerBase: 1500, staggerPerPeer: 600 },
      massive: { maxPeers: 100, concurrent: 1, cooldown: 3000, staggerBase: 2500, staggerPerPeer: 800 }
    }
    this._maxConnectedPeers = 100  // Hard limit
    this._priorityPeers = new Set()  // High priority peer IDs (speakers)
    this._isMassJoinInProgress = false  // Flag for batch processing
    this._pendingPeerCount = 0  // Track expected peer count during mass joins

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
  // Tiered connection management for scaling to 100+ peers
  // ---------------------------------------------------------------------------

  /**
   * Get current tier configuration based on peer count
   */
  _getTierConfig() {
    const count = this._peers.size + this._connectionQueue.length
    if (count <= this._tierConfig.small.maxPeers) return this._tierConfig.small
    if (count <= this._tierConfig.medium.maxPeers) return this._tierConfig.medium
    if (count <= this._tierConfig.large.maxPeers) return this._tierConfig.large
    return this._tierConfig.massive
  }

  /**
   * Check if we should accept new peer connections
   * Returns true if under limits, false otherwise
   */
  _canAcceptPeer(peerId) {
    const currentPeers = this._peers.size
    const maxPeers = this._maxConnectedPeers
    
    // Always allow priority peers
    if (this._priorityPeers.has(peerId)) return true
    
    // Hard limit check
    if (currentPeers >= maxPeers) {
      this._log(`Peer limit reached (${currentPeers}/${maxPeers}), rejecting ${peerId}`)
      return false
    }
    
    return true
  }

  /**
   * Set a peer as high priority (speaker)
   */
  setPeerPriority(peerId, isPriority = true) {
    if (isPriority) {
      this._priorityPeers.add(peerId)
      this._log(`Peer ${peerId} set as high priority`)
    } else {
      this._priorityPeers.delete(peerId)
    }
  }

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

    // If already connected, unpause immediately
    if (this._hasConnectedPeer()) {
      this._log('Peers already connected — unpausing immediately')
      this._player.unpause()
      return Promise.resolve()
    }

    // Store reference to player for callbacks
    const player = this._player

    // Listen for peerJoin events to unpause when a peer connects
    const onPeerJoin = () => {
      if (player && player._paused && !player._stopped) {
        this._log('Peer joined — unpausing audio pump from event')
        player.unpause()
      }
    }
    this.once('peerJoin', onPeerJoin)

    // Fallback 1: unpause after 2 s if peers exist but connected event was missed
    setTimeout(() => {
      if (player._paused && !player._stopped && this._peers.size > 0) {
        this._log('Fallback 2s: unpausing audio pump (peer exists, state unreliable)')
        player.unpause()
      }
    }, 2000)

    // Fallback 2: always unpause after 5 s regardless
    setTimeout(() => {
      if (player._paused && !player._stopped) {
        this._log('Fallback 5s: force-unpausing audio pump')
        player.unpause()
      }
      // Clean up the one-time listener
      this.off('peerJoin', onPeerJoin)
    }, 5000)

    return Promise.resolve()
  }

  _hasConnectedPeer() {
    for (const ps of this._peers.values()) {
      if (ps.pc?.connectionState === 'connected') return true
    }
    return false
  }

  _onPeerConnected() {
    // Guard: check if player exists and is in a state where we should unpause
    if (!this._player) {
      this._log('Peer connected — but no player exists yet')
      return
    }
    if (!this._player._paused) {
      this._log('Peer connected — audio pump already running')
      return
    }
    if (this._player._stopped) {
      this._log('Peer connected — but player is stopped')
      return
    }
    this._log(`Peer connected — starting audio pump (buf: ${this._player._buf.length} bytes)`)
    this._player.unpause()
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
    
    // Clear connection management state
    this._connectionQueue = []
    this._isConnecting = false
    this._activeNegotiations = 0
    this._connectionCooldowns.clear()
    
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
      // Additional settings for stability with multiple peers
      iceTransportPolicy: 'all',       // Use all available transport types
    })

    // Add audio track associated with our stream so the remote peer receives
    // event.streams[0] in their ontrack handler (required for Audio.srcObject)
    this._log(`Adding audio track to peer ${ps.peerId} — track enabled: ${this._audioTrack.enabled}, stream tracks: ${this._audioStream.getTracks().length}`)
    const sender = pc.addTrack(this._audioTrack, this._audioStream)
    this._log(`Audio track added — sender exists: ${!!sender}`)

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
        if (!ps._peerJoinEmitted) {
          ps._peerJoinEmitted = true
          this._onPeerConnected()
          this.emit('peerJoin', ps.peerId)
        }
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
    const peerIds = (participants || [])
      .map(p => p.id || p)
      .filter(pid => pid && pid !== this._botId)
    
    this._log(`Existing participants: ${peerIds.length} peers —`, peerIds)
    
    // Check if we're in a massive join scenario
    if (peerIds.length > 10) {
      this._isMassJoinInProgress = true
      this._pendingPeerCount = peerIds.length
      this._lastBatchProcessTime = Date.now()
      this._log(`Mass join detected: ${peerIds.length} peers. Using batch processing mode.`)
    }
    
    // Get tier config based on peer count
    const tier = this._getTierConfig()
    this._log(`Using tier config: concurrent=${tier.concurrent}, cooldown=${tier.cooldown}ms`)
    
    // For large groups, use batch processing
    if (peerIds.length > tier.maxPeers) {
      this._log(`Large group detected (${peerIds.length} peers), processing in batches`)
      this._processPeerBatches(peerIds)
      return
    }
    
    // Use tiered staggered delays
    const baseDelay = tier.staggerBase
    const staggerMs = tier.staggerPerPeer
    
    peerIds.forEach((pid, index) => {
      // Stagger offers with increasing delays to avoid simultaneous connection races
      const delay = baseDelay + (index * staggerMs) + (Math.random() * 200)
      this._log(`Queuing connection to ${pid} in ${Math.round(delay)}ms (position ${index + 1}/${peerIds.length})`)
      setTimeout(() => this._queueConnection(pid), delay)
    })
  }

  /**
   * Process large groups in batches to prevent overwhelming the system
   */
  _processPeerBatches(peerIds) {
    const tier = this._getTierConfig()
    const batchSize = Math.min(tier.maxPeers, 20) // Process max 20 at a time
    const batches = []
    
    // Split into batches
    for (let i = 0; i < peerIds.length; i += batchSize) {
      batches.push(peerIds.slice(i, i + batchSize))
    }
    
    this._log(`Split ${peerIds.length} peers into ${batches.length} batches of ~${batchSize}`)
    
    // Process batches with delays
    batches.forEach((batch, batchIndex) => {
      const batchDelay = batchIndex * 5000 // 5 seconds between batches
      
      setTimeout(() => {
        this._log(`Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} peers)`)
        
        batch.forEach((pid, index) => {
          // Skip if at peer limit
          if (!this._canAcceptPeer(pid)) return
          
          const delay = tier.staggerBase + (index * tier.staggerPerPeer) + (Math.random() * 200)
          setTimeout(() => this._queueConnection(pid), delay)
        })
        
        // Mark mass join complete after last batch
        if (batchIndex === batches.length - 1) {
          setTimeout(() => {
            this._isMassJoinInProgress = false
            this._pendingPeerCount = 0
            this._log('Mass join processing complete')
          }, 10000)
        }
      }, batchDelay)
    })
  }

  _onUserJoined(userInfo) {
    const userId = userInfo?.id || userInfo?.userId
    if (!userId || userId === this._botId) return
    this._log('User joined voice:', userId)
    
    // Check if we're at capacity
    if (!this._canAcceptPeer(userId)) {
      this._log(`Cannot accept peer ${userId}: at capacity`)
      return
    }
    
    // Use tiered delays
    const tier = this._getTierConfig()
    const peerCount = this._peers.size
    const delay = tier.staggerBase + (peerCount * tier.staggerPerPeer * 0.5) + (Math.random() * 300)
    this._log(`Scheduling connection to new peer ${userId} in ${Math.round(delay)}ms (tier: ${tier.maxPeers} max)`)
    setTimeout(() => this._queueConnection(userId), delay)
  }

  _onUserLeft(data) {
    const userId = data?.userId || data?.id
    if (!userId || userId === this._botId) return
    this._log('User left voice:', userId)
    this._destroyPeerState(userId)
    this.emit('peerLeave', userId)
  }

  /**
   * Queue a peer connection to prevent overwhelming the system with simultaneous negotiations.
   * This is critical for stability with multiple peers.
   */
  _queueConnection(remoteId) {
    // Check if at capacity
    if (!this._canAcceptPeer(remoteId)) {
      this._log(`Cannot queue ${remoteId}: at capacity`)
      return
    }

    // Check cooldown to prevent rapid reconnection attempts
    const tier = this._getTierConfig()
    const lastAttempt = this._connectionCooldowns.get(remoteId)
    if (lastAttempt && Date.now() - lastAttempt < tier.cooldown) {
      this._log(`Connection to ${remoteId} on cooldown, skipping`)
      return
    }

    // Check if already in queue
    if (this._connectionQueue.includes(remoteId)) {
      this._log(`Connection to ${remoteId} already queued`)
      return
    }

    // Check if already connected
    const existing = this._peers.get(remoteId)
    if (existing) {
      const state = existing.pc?.connectionState
      if (state === 'connected' || state === 'connecting') {
        this._log(`Already connected to ${remoteId}, skipping queue`)
        return
      }
    }

    this._connectionQueue.push(remoteId)
    this._log(`Queued connection to ${remoteId} (queue length: ${this._connectionQueue.length})`)
    this._processConnectionQueue()
  }

  /**
   * Process the connection queue with limited concurrency for stability.
   * Uses tiered configuration based on peer count.
   */
  async _processConnectionQueue() {
    if (this._isConnecting) return
    this._isConnecting = true

    const tier = this._getTierConfig()
    const maxConcurrent = tier.concurrent

    while (this._connectionQueue.length > 0 && this._activeNegotiations < maxConcurrent) {
      const remoteId = this._connectionQueue.shift()
      
      // Double-check state before connecting
      const existing = this._peers.get(remoteId)
      if (existing) {
        const state = existing.pc?.connectionState
        if (state === 'connected' || state === 'connecting' || existing.makingOffer) {
          this._log(`Skipping ${remoteId} — already connecting/connected`)
          continue
        }
      }

      this._activeNegotiations++
      this._connectionCooldowns.set(remoteId, Date.now())
      
      this._log(`Processing connection to ${remoteId} (${this._activeNegotiations}/${maxConcurrent} active negotiations, tier: ${tier.maxPeers} max)`)
      
      try {
        this._offerTo(remoteId)
      } catch (err) {
        this._log(`Error initiating connection to ${remoteId}:`, err.message)
        this._activeNegotiations = Math.max(0, this._activeNegotiations - 1)
      }

      // Tiered delay between starting connections to prevent flooding
      // Larger delays for larger groups
      if (this._connectionQueue.length > 0) {
        const delay = tier.staggerPerPeer
        await new Promise(r => setTimeout(r, delay))
      }
    }

    this._isConnecting = false
    
    // If queue still has items, schedule another processing round
    if (this._connectionQueue.length > 0) {
      setTimeout(() => this._processConnectionQueue(), tier.staggerBase)
    }
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
      if (state === 'connected' || state === 'connecting') {
        this._activeNegotiations = Math.max(0, this._activeNegotiations - 1)
        return
      }
      if (existing.makingOffer) {
        this._log(`_offerTo ${remoteId} skipped — offer already in flight`)
        this._activeNegotiations = Math.max(0, this._activeNegotiations - 1)
        return
      }
    }
    this._log('Creating peer connection for', remoteId)
    this._getOrCreatePeerState(remoteId)
    // onnegotiationneeded fires automatically after addTrack in _buildPeerConnection
    
    // Decrement counter after a delay to allow negotiation to complete
    setTimeout(() => {
      this._activeNegotiations = Math.max(0, this._activeNegotiations - 1)
      // Try to process more queued connections
      this._processConnectionQueue()
    }, 3000)
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
    const MAX = 40  // 40 × 250 ms = 10 s
    if (attempts >= MAX) {
      this._log(`Poll timed out for ${ps.peerId} — forcing unpause`)
      this._onPeerConnected()
      return
    }
    setTimeout(() => {
      if (!ps.pc) return
      const state = ps.pc.connectionState
      if (attempts === 0 || attempts % 4 === 0) {
        this._log(`Poll connectionState for ${ps.peerId}: ${state} (attempt ${attempts + 1})`)
      }
      if (state === 'connected') {
        if (!ps._peerJoinEmitted) {
          ps._peerJoinEmitted = true
          this._onPeerConnected()
          this.emit('peerJoin', ps.peerId)
        }
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
