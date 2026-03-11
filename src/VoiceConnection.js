import { EventEmitter } from './EventEmitter.js'
import { createRequire } from 'module'
import path from 'path'
import { AudioPlayer } from './voice/AudioPlayer.js'
import { VideoPlayer } from './voice/VideoPlayer.js'
import { StreamPlayer } from './voice/StreamPlayer.js'
import { DualStreamPlayer } from './voice/DualStreamPlayer.js'
import { PeerState } from './voice/PeerState.js'
import { isHttpInput, sanitizeMediaInput } from './voice/mediaUtils.js'

const require = createRequire(import.meta.url)
const DEFAULT_DUALSTREAM_NO_MEDIA_TIMEOUT_MS = 5500

function loadWrtc() {
  try {
    return require('@roamhq/wrtc')
  } catch {
    throw new Error(
      '[Wire/Voice] @roamhq/wrtc is not installed. Run: npm install @roamhq/wrtc'
    )
  }
}

function buildIceServers(extraServers = []) {
  const servers = [
    // Keep ICE list small for faster candidate discovery.
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turns:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]

  // Environment variable TURN servers (for custom TURN deployments)
  const turnUrl  = process.env.TURN_URL  || null
  const turnUser = process.env.TURN_USER || null
  const turnPass = process.env.TURN_PASS || null
  if (turnUrl && turnUser && turnPass) {
    servers.push({ urls: turnUrl, username: turnUser, credential: turnPass })
    const turnsUrl = turnUrl.replace(/^turn:/, 'turns:')
    if (turnsUrl !== turnUrl) {
      servers.push({ urls: turnsUrl, username: turnUser, credential: turnPass })
    }
  }

  return [...servers, ...extraServers]
}
export class VoiceConnection extends EventEmitter {
  constructor(socket, botId, serverId, channelId, options = {}) {
    super()
    this._socket     = socket
    this._botId      = botId
    this._serverId   = serverId
    this._channelId  = channelId
    this._debug      = options.debug || false
    this._iceServers = buildIceServers(options.iceServers || [])
    this._encrypted  = options.encrypted !== false // Default to encrypted

    const wrtc = loadWrtc()
    this._RTCPeerConnection     = wrtc.RTCPeerConnection
    this._RTCSessionDescription = wrtc.RTCSessionDescription
    this._RTCIceCandidate       = wrtc.RTCIceCandidate
    this._RTCRtpSender          = wrtc.RTCRtpSender || globalThis.RTCRtpSender || null
    this._MediaStream           = wrtc.MediaStream
    const { RTCAudioSource, RTCVideoSource }    = wrtc.nonstandard

    this._audioSource = new RTCAudioSource()
    this._audioTrack  = this._audioSource.createTrack()
    this._audioTrack.enabled = true
    this._audioStream = new this._MediaStream([this._audioTrack])

    this._videoSource = null
    this._videoTrack  = null
    this._videoStream = null
    this._videoType   = null
    this._videoSender = null
    this._lastVideoAnnouncementKey = null
    this._videoTransitioning = false  // Flag to prevent stop announcement during video transitions

    this._peers     = new Map()
    this._player    = null
    this._videoPlayer = null
    this._dualStreamPlayer = null
    this._dualStreamStarted = false
    this._dualStreamStartup = null
    const dualNoMediaTimeoutRaw = Number(process.env.WIRE_DUALSTREAM_NO_MEDIA_TIMEOUT_MS)
    this._dualStreamNoMediaTimeoutMs = Number.isFinite(dualNoMediaTimeoutRaw)
      ? Math.max(0, dualNoMediaTimeoutRaw)
      : DEFAULT_DUALSTREAM_NO_MEDIA_TIMEOUT_MS
    this._lastAudioPlayback = null
    this._lastVideoPlayback = null
    this._useDualStream = true
    this._videoPlaybackRequested = false  // Track if video playback was requested
    this._heartbeat = null
    this._joined    = false
    this._syncInterval = null
    this._peerMonitorInterval = null

    this._connectionQueue = []
    this._isConnecting = false
    this._activeNegotiations = 0
    this._connectionCooldowns = new Map()
    
    this._tierConfig = {
      small: { maxPeers: 10, concurrent: 2, cooldown: 1000, staggerBase: 300, staggerPerPeer: 200 },
      medium: { maxPeers: 25, concurrent: 2, cooldown: 1500, staggerBase: 800, staggerPerPeer: 400 },
      large: { maxPeers: 50, concurrent: 1, cooldown: 2000, staggerBase: 1500, staggerPerPeer: 600 },
      massive: { maxPeers: 100, concurrent: 1, cooldown: 3000, staggerBase: 2500, staggerPerPeer: 800 }
    }
    this._maxConnectedPeers = 100
    this._priorityPeers = new Set()
    this._isMassJoinInProgress = false
    this._pendingPeerCount = 0

    this._voiceEffect = {
      enabled: false,
      type: 'none',
      pitch: 0,
      reverb: 0,
      distortion: 0,
      echo: 0,
      tremolo: 0,
      robot: false,
      alien: false //MAX HEADROOM INCIDENT MODE............... OOOOOO MY PILES!
    }
    this._throttledLogState = new Map()

    this._onParticipants  = this._onParticipants.bind(this)
    this._onUserJoined    = this._onUserJoined.bind(this)
    this._onUserLeft      = this._onUserLeft.bind(this)
    this._onUserReconnected = this._onUserReconnected.bind(this)
    this._onUserUpdated   = this._onUserUpdated.bind(this)
    this._onVideoUpdate  = this._onVideoUpdate.bind(this)
    this._onScreenShareUpdate = this._onScreenShareUpdate.bind(this)
    this._onOffer         = this._onOffer.bind(this)
    this._onAnswer        = this._onAnswer.bind(this)
    this._onIceCandidate  = this._onIceCandidate.bind(this)
    this._onForceReconnect = this._onForceReconnect.bind(this)
    this._onResyncRequest = this._onResyncRequest.bind(this)
    this._onSocketConnect = this._onSocketConnect.bind(this)
    this._onAnyDebug      = this._onAnyDebug.bind(this)
  }

  _log(...args) { if (this._debug) console.log('[Wire/Voice]', ...args) }

  _waitForStable(pc) {
    if (pc.signalingState === 'stable') return Promise.resolve()
    return new Promise(resolve => {
      const onChange = () => {
        if (pc.signalingState === 'stable') {
          pc.removeEventListener('signalingstatechange', onChange)
          resolve()
        }
      }
      pc.addEventListener('signalingstatechange', onChange)
    })
  }

  async _safeNegotiate(ps, iceRestart = false) {
    if (ps._negotiating) {
      ps._negotiateQueued = true
      this._log(`Queued negotiation for ${ps.peerId}`)
      return
    }

    ps._negotiating = true
    try {
      if (ps.pc.signalingState !== 'stable') {
        this._log(`Waiting for stable signaling for ${ps.peerId}`)
        await this._waitForStable(ps.pc)
      }

      await this._negotiate(ps, { iceRestart })
    } finally {
      ps._negotiating = false

      if (ps._negotiateQueued) {
        ps._negotiateQueued = false
        this._log(`Running queued negotiation for ${ps.peerId}`)
        queueMicrotask(() => this._safeNegotiate(ps, iceRestart))
      }
    }
  }

  _negotiationCooldown = new Map()

  _canNegotiate(ps) {
    const now = Date.now()
    const lastNegotiation = this._negotiationCooldown.get(ps.peerId) || 0
    if (now - lastNegotiation < 500) {
      return false
    }
    this._negotiationCooldown.set(ps.peerId, now)
    return true
  }

  _ensureTransceivers(pc) {
    // Only add recvonly transceivers if we don't have any tracks to send yet
    // This ensures proper negotiation with Chrome which is strict about transceiver setup
    const transceivers = pc.getTransceivers()
    const hasAudio = transceivers.some(t => t.sender?.track?.kind === 'audio' || t.receiver?.track?.kind === 'audio')
    const hasVideo = transceivers.some(t => t.sender?.track?.kind === 'video' || t.receiver?.track?.kind === 'video')
    
    // Only add transceivers if they don't exist at all
    // Use 'sendrecv' direction to allow bidirectional media flow (Chrome prefers this)
    if (!hasAudio) {
      pc.addTransceiver('audio', { direction: 'sendrecv' })
      this._log('Added audio transceiver with sendrecv direction')
    }
    // Only add video transceiver if video playback was explicitly requested
    if (!hasVideo && this._videoPlaybackRequested && this._videoTrack) {
      pc.addTransceiver('video', { direction: 'sendrecv' })
      this._log('Added video transceiver with sendrecv direction')
    }
  }

  _addIceCandidate(ps, candidate) {
    const pc = ps.pc
    if (!pc || !candidate) return
    
    if (pc.remoteDescription) {
      pc.addIceCandidate(candidate).catch(() => {})
    } else {
      ps._pendingIce = ps._pendingIce || []
      ps._pendingIce.push(candidate)
    }
  }

  _flushPendingIce(ps) {
    const pc = ps.pc
    if (!pc) return
    const pending = ps._pendingIce || []
    ps._pendingIce = []
    for (const c of pending) {
      try { pc.addIceCandidate(c).catch(() => {}) } catch {}
    }
  }

  _setCodecPreferences(pc) {
    try {
      // Get audio transceivers
      const audioTransceivers = pc.getTransceivers().filter(t => t.sender?.track?.kind === 'audio')
      
      if (audioTransceivers.length > 0) {
        const senderApi = this._RTCRtpSender
        const audioCaps = senderApi?.getCapabilities?.('audio')?.codecs || []
        if (audioCaps.length > 0) {
          // Chrome requires ALL codecs to be passed, sorted by preference
          // Put Opus first, then all other codecs
          const opusCodecs = audioCaps.filter(c => c.mimeType.toLowerCase() === 'audio/opus')
          const otherCodecs = audioCaps.filter(c => c.mimeType.toLowerCase() !== 'audio/opus')
          const sortedCodecs = [...opusCodecs, ...otherCodecs]
          
          audioTransceivers.forEach(t => {
            try { 
              t.setCodecPreferences(sortedCodecs)
              this._log('Set audio codec preferences for transceiver, Opus first among', sortedCodecs.length, 'codecs')
            } catch (err) {
              this._log('Failed to set audio codec preferences:', err.message)
            }
          })
        }
      }
      
      // Set video codec preferences - VP8 ONLY for Chrome A/V sync
      // VP9 and AV1 cause 300-800ms drift on Chrome
      const videoTransceivers = pc.getTransceivers().filter(t => t.sender?.track?.kind === 'video')
      if (videoTransceivers.length > 0) {
        const senderApi = this._RTCRtpSender
        const videoCaps = senderApi?.getCapabilities?.('video')?.codecs || []
        if (videoCaps.length > 0) {
          // ONLY use VP8 for Chrome A/V sync - VP9/AV1 cause drift
          const vp8Codecs = videoCaps.filter(c => c.mimeType.toLowerCase() === 'video/vp8')
          // Fallback to H264 if VP8 not available
          const h264Codecs = videoCaps.filter(c => c.mimeType.toLowerCase() === 'video/h264')
          
          // Use VP8 only, or H264 as fallback - NO VP9/AV1
          const sortedVideoCodecs = vp8Codecs.length > 0 ? vp8Codecs : h264Codecs
          
          videoTransceivers.forEach(t => {
            try { 
              if (sortedVideoCodecs.length > 0) {
                t.setCodecPreferences(sortedVideoCodecs)
                this._log('Set video codec preferences, VP8 only (for A/V sync) among', sortedVideoCodecs.length, 'codecs')
              }
            } catch (err) {
              this._log('Failed to set video codec preferences:', err.message)
            }
          })
        }
      }
    } catch (err) {
      this._log('Failed to set codec preferences:', err.message)
    }
  }
  
  _enhanceOpusSdp(description) {
    if (!description?.sdp || typeof description.sdp !== 'string') return description

    let sdp = description.sdp
    const opusPayloads = []
    const opusRegex = /^a=rtpmap:(\d+)\s+opus\/48000(?:\/2)?$/gim
    let match
    while ((match = opusRegex.exec(sdp)) !== null) {
      opusPayloads.push(match[1])
    }
    if (opusPayloads.length === 0) return description

    const forcedParams = {
      stereo: '1',
      'sprop-stereo': '1',
      channels: '2',
      maxaveragebitrate: '192000',
      cbr: '0',
      useinbandfec: '1',
      usedtx: '0'
    }

    for (const payload of opusPayloads) {
      // Ensure RTP map explicitly advertises 2 channels.
      const rtpmapNormalizeRegex = new RegExp(`^a=rtpmap:${payload}\\s+opus\\/48000(?:\\/2)?$`, 'mi')
      sdp = sdp.replace(rtpmapNormalizeRegex, `a=rtpmap:${payload} opus/48000/2`)

      const fmtpRegex = new RegExp(`^a=fmtp:${payload}\\s+(.+)$`, 'mi')
      const fmtpMatch = sdp.match(fmtpRegex)

      if (fmtpMatch) {
        const parsed = {}
        fmtpMatch[1]
          .split(';')
          .map(p => p.trim())
          .filter(Boolean)
          .forEach((pair) => {
            const [rawKey, ...rest] = pair.split('=')
            const key = String(rawKey || '').trim()
            if (!key) return
            const value = rest.length ? rest.join('=').trim() : ''
            parsed[key.toLowerCase()] = value
          })

        for (const [k, v] of Object.entries(forcedParams)) {
          parsed[k] = v
        }

        const rebuilt = Object.entries(parsed)
          .map(([k, v]) => (v ? `${k}=${v}` : k))
          .join(';')
        sdp = sdp.replace(fmtpRegex, `a=fmtp:${payload} ${rebuilt}`)
      } else {
        const rtpmapLineRegex = new RegExp(`^a=rtpmap:${payload}\\s+opus\\/48000(?:\\/2)?$`, 'mi')
        const insertion = `a=fmtp:${payload} ${Object.entries(forcedParams).map(([k, v]) => `${k}=${v}`).join(';')}`
        sdp = sdp.replace(rtpmapLineRegex, (line) => `${line}\r\n${insertion}`)
      }
    }

    return { ...description, sdp }
  }

  _setAudioQuality(pc, bitrate = 192000) {
    try {
      const senders = pc.getSenders()
      const audioSender = senders.find(s => s.track?.kind === 'audio')
      if (!audioSender) return

      const params = audioSender.getParameters()
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}]
      }

      const encoding = {
        ...params.encodings[0],
        maxBitrate: bitrate
      }
      if (typeof encoding.dtx === 'undefined') {
        encoding.dtx = 'disabled'
      }
      params.encodings[0] = encoding

      audioSender.setParameters(params).then(() => {
        this._log(`Set audio bitrate to ${Math.round(bitrate / 1000)} kbps with DTX disabled`)
      }).catch(err => {
        this._log('Failed to set audio bitrate params:', err.message)
      })
    } catch (err) {
      this._log('Failed to set audio quality params:', err.message)
    }
  }

  _getAdaptiveVideoBitrate() {
    const peerCount = Math.max(1, this._peers?.size || 1)
    if (peerCount >= 5) return 2200000
    if (peerCount === 4) return 2800000
    if (peerCount === 3) return 3500000
    if (peerCount === 2) return 4500000
    return 5500000
  }

  // Set adaptive bitrate for video to balance quality and stability as peer count changes
  _setVideoBitrate(pc, bitrate = null) {
    try {
      const senders = pc.getSenders()
      const videoSender = senders.find(s => s.track?.kind === 'video')
      
      if (videoSender) {
        const targetBitrate = Number.isFinite(bitrate) ? bitrate : this._getAdaptiveVideoBitrate()
        const params = videoSender.getParameters()
        if (!params.encodings) params.encodings = [{}]
        
        params.encodings[0] = {
          ...params.encodings[0],
          maxBitrate: targetBitrate,
          maxFramerate: 24,
          scaleResolutionDownBy: 1    // Don't downscale
        }
        
        videoSender.setParameters(params).then(() => {
          this._log(`Set video bitrate to ${(targetBitrate / 1000000).toFixed(2)} Mbps (peers=${this._peers?.size || 0})`)
        }).catch(err => {
          this._log('Failed to set video bitrate:', err.message)
        })
      }
    } catch (err) {
      this._log('Failed to set video bitrate:', err.message)
    }
  }

  _logThrottled(key, cooldownMs, ...args) {
    const now = Date.now()
    const last = this._throttledLogState.get(key) || 0
    if ((now - last) < cooldownMs) return
    this._throttledLogState.set(key, now)
    this._log(...args)
  }

  _onAnyDebug(event, data) {
    if (!event.startsWith('voice:')) return
    this._log(`Socket event: ${event}`, data)
  }

  _reportPeerState(peerId, state) {
    if (!this._socket?.connected) return
    this._socket.emit('voice:peer-state-report', {
      channelId: this._channelId,
      targetPeerId: peerId,
      state: state,
      timestamp: Date.now()
    })
  }

  _getVideoSignalEvent(videoType) {
    if (videoType === 'screen') return 'voice:screen-share'
    if (videoType === 'camera') return 'voice:video'
    return null
  }

  _announceVideoState({ enabled, videoType = this._videoType, force = false, reason = 'unknown' } = {}) {
    if (typeof enabled !== 'boolean') return false
    if (!this._socket?.connected) return false

    const eventName = this._getVideoSignalEvent(videoType)
    if (!eventName) return false

    const key = `${eventName}:${enabled}`
    if (!force && this._lastVideoAnnouncementKey === key) {
      this._log(`Skipping duplicate ${eventName} announcement (${reason})`)
      return false
    }

    // Emit video state to all clients in channel
    this._socket.emit(eventName, {
      channelId: this._channelId,
      userId: this._botId,
      enabled,
    })
    
    // Also emit video-update/screen-share-update events for proper client handling
    // Use 'type' field (not 'videoType') to match client expectations
    const updateEventName = videoType === 'screen' ? 'voice:screen-share-update' : 'voice:video-update'
    this._socket.emit(updateEventName, {
      channelId: this._channelId,
      userId: this._botId,
      enabled,
      type: videoType,  // Changed from 'videoType' to 'type' to match client expectations
      videoType: videoType,  // Keep both for backwards compatibility
    })
    
    this._lastVideoAnnouncementKey = key
    this._log(`Announced ${eventName} enabled=${enabled} (${reason})`)
    return true
  }

  _restoreVideoSignalingState(reason = 'restore') {
    if (!this._joined || !this._socket?.connected) return
    if (!this._videoTrack || !this._videoType) return
    if (!this._videoPlaybackRequested) {
      this._log(`Skipping video signaling restore - video not requested (${reason})`)
      return
    }
    this._announceVideoState({
      enabled: true,
      videoType: this._videoType,
      force: true,
      reason,
    })
    this._addVideoTrackToPeers()
  }

  _onSocketConnect() {
    if (!this._joined) return
    this._log('Socket connected — rejoining channel and restoring media signaling (hopefully........ hopefully))')
    const peerIdsToReconnect = [...this._peers.keys()]
    if (peerIdsToReconnect.length > 0) {
      this._log(`Resetting ${peerIdsToReconnect.length} peer connections after socket reconnect`)
      this._clearAllPeers()
      peerIdsToReconnect.forEach((peerId, index) => {
        setTimeout(() => this._queueConnection(peerId), Math.min(2000, index * 120))
      })
    }
    this._socket.emit('voice:join', {
      channelId: this._channelId,
      serverId:  this._serverId,
      peerId:    this._botId,
    })
    if (this._socket?.connected) {
      this._socket.emit('voice:heartbeat', { channelId: this._channelId })
    }
    this._restoreVideoSignalingState('socket-reconnect')
  }

  _getTierConfig() {
    const count = this._peers.size + this._connectionQueue.length
    if (count <= this._tierConfig.small.maxPeers) return this._tierConfig.small
    if (count <= this._tierConfig.medium.maxPeers) return this._tierConfig.medium
    if (count <= this._tierConfig.large.maxPeers) return this._tierConfig.large
    return this._tierConfig.massive
  }

  _canAcceptPeer(peerId) {
    const currentPeers = this._peers.size
    const maxPeers = this._maxConnectedPeers
    if (this._priorityPeers.has(peerId)) return true
    if (currentPeers >= maxPeers) {
      this._log(`Peer limit reached (${currentPeers}/${maxPeers}), rejecting ${peerId}`)
      return false
    }
    return true
  }

  setPeerPriority(peerId, isPriority = true) {
    if (isPriority) {
      this._priorityPeers.add(peerId)
      this._log(`Peer ${peerId} set as high priority`)
    } else {
      this._priorityPeers.delete(peerId)
    }
  }

  join() {
    return new Promise((resolve) => {
      if (this._joined) {
        this._restoreVideoSignalingState('join-noop')
        resolve(this)
        return
      }

      this._registerSocketListeners()

      this._socket.emit('voice:join', {
        channelId: this._channelId,
        serverId:  this._serverId,
        peerId:    this._botId,
      })

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

  playFile(filePath, { loop = false, effect = null, seekMs = 0 } = {}) {
    this.stopAudio()
    const resolved = path.resolve(filePath)
    const normalizedSeekMs = Math.max(0, Number(seekMs) || 0)
    this._lastAudioPlayback = {
      type: 'file',
      source: resolved,
      options: { loop, effect },
    }
    
    const playerEffect = effect || this._voiceEffect
    this._player = new AudioPlayer(this._audioSource, resolved, loop, playerEffect, normalizedSeekMs)
    this._player.on('finish', () => { this._log('Audio finished:', resolved); this.emit('finish') })
    this._player.on('error',  (err) => { this._log('Audio error:', err.message); this.emit('error', err) })
    this._player.start()

    if (this._hasConnectedPeer()) {
      this._log('Peers already connected — unpausing audio')
      this._player.unpause()
      return Promise.resolve()
    }

    const onPeerJoin = () => {
      if (this._player && this._player._paused) {
        this._log('Peer joined — unpausing audio')
        this._player.unpause()
      }
    }
    this.once('peerJoin', onPeerJoin)

    setTimeout(() => {
      if (this._player._paused && !this._player._stopped) {
        this._log('Fallback: unpausing audio')
        this._player.unpause()
      }
      this.off('peerJoin', onPeerJoin)
    }, 5000)

    return Promise.resolve()
  }

  playUrl(url, { loop = false, effect = null, seekMs = 0 } = {}) {
    this.stopAudio()
    const normalizedUrl = sanitizeMediaInput(url)
    if (!normalizedUrl || !isHttpInput(normalizedUrl)) {
      const err = new Error('playUrl expects a valid http(s) URL')
      this._log('Stream error:', err.message)
      this.emit('error', err)
      return Promise.reject(err)
    }
    
    const normalizedSeekMs = Math.max(0, Number(seekMs) || 0)
    this._lastAudioPlayback = {
      type: 'url',
      source: normalizedUrl,
      options: { loop, effect },
    }
    
    const playerEffect = effect || this._voiceEffect
    this._player = new StreamPlayer(this._audioSource, normalizedUrl, loop, playerEffect, normalizedSeekMs)
    this._player.on('finish', () => { this._log('Stream finished:', normalizedUrl); this.emit('finish') })
    this._player.on('error',  (err) => { this._log('Stream error:', err.message); this.emit('error', err) })
    this._player.on('urlExpired',  (err) => { this._log('Stream URL expired:', err.message); this.emit('audioUrlExpired', err) })
    this._player.start()

    if (this._hasConnectedPeer()) {
      this._log('Peers already connected — unpausing stream')
      this._player.unpause()
      return Promise.resolve()
    }

    const onPeerJoin = () => {
      if (this._player && this._player._paused) {
        this._log('Peer joined — unpausing stream')
        this._player.unpause()
      }
    }
    this.once('peerJoin', onPeerJoin)

    setTimeout(() => {
      if (this._player._paused && !this._player._stopped) {
        this._log('Fallback: unpausing stream')
        this._player.unpause()
      }
      this.off('peerJoin', onPeerJoin)
    }, 5000)

    return Promise.resolve()
  }

  _buildVideoProfile(targetHeight = null, targetFps = null) {
    const safeHeight = Math.max(360, Number(targetHeight) || 900)
    const safeFps = Math.max(15, Math.min(30, Number(targetFps) || 24))
    let width = Math.round((safeHeight * 16) / 9)
    if (width % 2 !== 0) width += 1
    const height = safeHeight % 2 === 0 ? safeHeight : safeHeight + 1
    return { width, height, fps: safeFps }
  }

  _clearDualStreamStartup() {
    const startup = this._dualStreamStartup
    if (!startup) return

    if (startup.pollTimer) {
      clearTimeout(startup.pollTimer)
      startup.pollTimer = null
    }

    if (startup.peerJoinFallbackTimer) {
      clearTimeout(startup.peerJoinFallbackTimer)
      startup.peerJoinFallbackTimer = null
    }

    if (startup.onPeerJoin) {
      this.off('peerJoin', startup.onPeerJoin)
      startup.onPeerJoin = null
    }

    this._dualStreamStartup = null
  }

  _logDualStreamStartupState(startup, state, detail = '') {
    if (!startup) return
    if (startup.lastLoggedState === state && startup.lastLoggedDetail === detail) return
    startup.lastLoggedState = state
    startup.lastLoggedDetail = detail
    const suffix = detail ? ` (${detail})` : ''
    console.log(`[Wire/Voice/Startup] DualStream state=${state}${suffix}`)
  }

  _startDualStreamStartupController() {
    this._clearDualStreamStartup()

    if (!this._dualStreamPlayer) return

    const startup = {
      player: this._dualStreamPlayer,
      startRequested: false,
      startRequestedAt: 0,
      mediaDeadlineAt: 0,
      pollTimer: null,
      peerJoinFallbackTimer: null,
      onPeerJoin: null,
      fallbackTriggered: false,
      fallbackReason: null,
      lastLoggedState: null,
      lastLoggedDetail: null,
    }
    this._dualStreamStartup = startup

    if (this._hasConnectedPeer()) {
      this._logDualStreamStartupState(startup, 'waiting-start', 'connected-peer')
      this._log('Peers already connected — preparing deterministic DualStream start')
      this._requestDualStreamStart('connected-peer')
      return
    }

    this._logDualStreamStartupState(startup, 'waiting-peer', 'no connected peers yet')
    startup.onPeerJoin = () => {
      this._logDualStreamStartupState(startup, 'waiting-start', 'peer-join')
      this._log('Peer joined — preparing deterministic DualStream start')
      this._requestDualStreamStart('peer-join')
    }
    this.once('peerJoin', startup.onPeerJoin)

    startup.peerJoinFallbackTimer = setTimeout(() => {
      this._logDualStreamStartupState(startup, 'waiting-start', 'peer-join-timeout')
      this._log('Fallback: no peer join event — preparing deterministic DualStream start')
      this._requestDualStreamStart('peer-join-timeout')
    }, 2000)
  }

  _requestDualStreamStart(trigger = 'unknown') {
    const startup = this._dualStreamStartup
    if (!startup) return
    if (!this._dualStreamPlayer || this._dualStreamPlayer !== startup.player) return
    if (this._dualStreamStarted || startup.startRequested) return

    startup.startRequested = true
    startup.startRequestedAt = Date.now()
    this._logDualStreamStartupState(startup, 'start-requested', trigger)
    this._log(`DualStream start requested (${trigger})`)

    const startNow = (reason) => {
      if (!this._dualStreamPlayer || this._dualStreamPlayer !== startup.player) return
      if (this._dualStreamStarted) return
      this._dualStreamPlayer.unpause(Date.now())
      this._dualStreamStarted = true
      this._logDualStreamStartupState(startup, 'started', reason)
      this._log(`DualStream started (${reason})`)
      if (this._dualStreamNoMediaTimeoutMs <= 0) {
        this._logDualStreamStartupState(startup, 'startup-monitor-disabled', 'timeout<=0')
        this._log('DualStream no-media failover disabled (timeout <= 0)')
        this._clearDualStreamStartup()
        return
      }
      startup.mediaDeadlineAt = Date.now() + this._dualStreamNoMediaTimeoutMs
      startup.pollTimer = setTimeout(poll, 40)
    }

    const switchToSplitPipeline = (reason) => {
      if (startup.fallbackTriggered) return
      startup.fallbackTriggered = true
      startup.fallbackReason = reason
      this._logDualStreamStartupState(startup, 'fallback-split-av', reason)
      console.log(`[Wire/Voice/Startup] DualStream fallback reason=${reason}`)
      this._clearDualStreamStartup()

      if (!this._dualStreamPlayer || this._dualStreamPlayer !== startup.player) return
      if (!this._lastVideoPlayback?.filePath) return

      const req = this._lastVideoPlayback
      const options = req.options || {}
      const resumeAtMs = Math.max(
        Number(this._dualStreamPlayer.getAudioPosition?.()) || 0,
        Number(this._dualStreamPlayer.getVideoPosition?.()) || 0,
      )

      this._log(`DualStream failover to split A/V (${reason}, seek=${resumeAtMs}ms)`)
      // Fully clear playback-request state before restarting in split mode,
      // otherwise playVideo() can recurse in "already playing" wait loops.
      this.stopVideo({ preservePlaybackRequest: false })
      this.playVideo(req.filePath, {
        ...options,
        useDualStream: false,
        seekMs: resumeAtMs,
      }).catch(err => {
        this._log('Split A/V fallback failed:', err?.message || err)
        this.emit('videoError', err)
      })
    }

    const softTimeoutMs = 2000
    const hardTimeoutMs = 5500
    const poll = () => {
      if (!this._dualStreamPlayer || this._dualStreamPlayer !== startup.player) {
        this._clearDualStreamStartup()
        return
      }
      if (this._dualStreamStarted) {
        const videoSent = Number(startup.player.getVideoBufferStatus?.().framesSent) || 0
        const audioSent = Number(startup.player.getAudioBufferStatus?.().framesSent) || 0
        if (videoSent > 0 || audioSent > 0) {
          this._logDualStreamStartupState(startup, 'media-flow-confirmed', `videoSent=${videoSent},audioSent=${audioSent}`)
          this._log(`DualStream media flow confirmed (videoSent=${videoSent}, audioSent=${audioSent})`)
          this._clearDualStreamStartup()
          return
        }

        if (startup.mediaDeadlineAt > 0 && Date.now() >= startup.mediaDeadlineAt) {
          switchToSplitPipeline(`no media emitted within ${this._dualStreamNoMediaTimeoutMs}ms after start`)
          return
        }

        startup.pollTimer = setTimeout(poll, 40)
        return
      }

      const elapsedMs = Date.now() - startup.startRequestedAt
      const videoStatus = startup.player.getVideoBufferStatus?.() || {}
      const audioStatus = startup.player.getAudioBufferStatus?.() || {}
      const videoFrames = Number(videoStatus.bufferedFrames) || 0
      const audioFrames = Number(audioStatus.bufferedFrames) || 0
      const videoInitialized = !!videoStatus.initialized

      if (videoInitialized && videoFrames > 0 && audioFrames > 0) {
        startNow(`decoder-ready after ${elapsedMs}ms`)
        return
      }

      if (elapsedMs > softTimeoutMs && (videoFrames > 0 || audioFrames > 0 || videoInitialized)) {
        startNow(`soft-timeout after ${elapsedMs}ms (videoFrames=${videoFrames}, audioFrames=${audioFrames}, initialized=${videoInitialized})`)
        return
      }

      if (elapsedMs > hardTimeoutMs) {
        switchToSplitPipeline(`no decoder init after ${elapsedMs}ms`)
        return
      }

      startup.pollTimer = setTimeout(poll, 25)
    }

    poll()
  }

  playVideo(filePath, { loop = false, type = 'screen', audioUrl = null, useDualStream = false, seekMs = 0, targetHeight = null, targetFps = null } = {}) {
    console.log(`[Wire/Voice] playVideo called with type=${type}, useDualStream=${useDualStream}, targetHeight=${targetHeight ?? 'auto'}, targetFps=${targetFps ?? 'auto'}`)
    
    if (this._videoPlaybackRequested) {
      this._log(`Video already playing, waiting 1s for cleanup before starting new video`)
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          this.playVideo(filePath, { loop, type, audioUrl, useDualStream, seekMs, targetHeight, targetFps })
            .then(resolve)
            .catch(reject)
        }, 1000)
      })
    }
    
    this._videoTransitioning = true
    this._videoPlaybackRequested = true
    console.log(`[Wire/Voice] Video playback requested - setting _videoPlaybackRequested = true`)
    
    this.stopVideo({ preservePlaybackRequest: true })
    this.stopAudio()
    
    const { RTCVideoSource } = loadWrtc().nonstandard
    this._videoSource = new RTCVideoSource({ isScreencast: type === 'screen' })
    this._videoTrack  = this._videoSource.createTrack()
    this._videoTrack.enabled = true
    try { this._videoTrack.contentHint = 'detail' } catch {}
    this._videoTrack._senderTag = type
    this._videoStream = new this._MediaStream([this._videoTrack])
    this._videoType   = type
    console.log(`[Wire/Voice] Video track created: ${!!this._videoTrack}, Video stream created: ${!!this._videoStream}, Type: ${type}`)

    const normalizedInput = sanitizeMediaInput(filePath)
    if (!normalizedInput) {
      const err = new Error('playVideo requires a valid path or URL')
      this._log('Video error:', err.message)
      this.emit('videoError', err)
      return Promise.reject(err)
    }

    const isUrl = isHttpInput(normalizedInput)
    const source = isUrl ? normalizedInput : path.resolve(normalizedInput)
    const normalizedSeekMs = Math.max(0, Number(seekMs) || 0)
    
    const normalizedAudioInput = sanitizeMediaInput(audioUrl)
    const audioInput = normalizedAudioInput || source
    const audioSourcePath = isHttpInput(audioInput) ? audioInput : path.resolve(audioInput)

    this._lastVideoPlayback = {
      filePath: normalizedInput,
      options: { loop, type, audioUrl: normalizedAudioInput || null, useDualStream, targetHeight, targetFps }
    }
    const videoProfile = this._buildVideoProfile(targetHeight, targetFps)
    
    if (useDualStream && this._useDualStream) {
      this._log(`Using DualStreamPlayer for synced A/V (single ffmpeg) @ ${videoProfile.width}x${videoProfile.height} ${videoProfile.fps}fps`)
      
      this._dualStreamPlayer = new DualStreamPlayer(
        this._videoSource, 
        this._audioSource, 
        source, 
        audioSourcePath, 
        loop, 
        this._voiceEffect,
        normalizedSeekMs,
        videoProfile
      )
      
      this._dualStreamPlayer.on('finish', () => { 
        this._log('DualStream finished:', source)
        this.emit('videoFinish')
        this.stopVideo()
      })
      this._dualStreamPlayer.on('error', (err) => { 
        this._log('DualStream error:', err.message); 
        this.emit('videoError', err) 
      })
      this._dualStreamPlayer.on('urlExpired', (err) => { 
        this._log('DualStream URL expired:', err.message); 
        this.emit('videoUrlExpired', err) 
      })
      
      this._dualStreamPlayer.start()
      this._dualStreamPlayer.prime()
      this._dualStreamStarted = false
      this._log(`Playing with DualStream: ${source} (type: ${type})`)
      
      this._announceVideoState({ enabled: true, videoType: type, reason: 'playVideo-start' })
      this._addVideoTrackToPeers()
      this._startDualStreamStartupController()
      
      return Promise.resolve()
    }
    
    this._videoPlayer = new VideoPlayer(this._videoSource, source, loop, normalizedSeekMs, videoProfile)
    this._videoPlayer.on('finish', () => { 
      this._log('Video finished:', source)
      this.emit('videoFinish')
      this.stopVideo()
    })
    this._videoPlayer.on('error',  (err) => { 
      this._log('Video error:', err.message)
      this.emit('videoError', err) 
    })
    this._videoPlayer.on('urlExpired',  (err) => { 
      this._log('Video URL expired:', err.message)
      this.emit('videoUrlExpired', err) 
    })
    this._videoPlayer.start()
    this._videoPlayer.prime()
    this._log(`Playing video: ${source} (type: ${type})`)
    
    if (isHttpInput(audioSourcePath)) {
      this._player = new StreamPlayer(this._audioSource, audioSourcePath, loop, this._voiceEffect, normalizedSeekMs)
    } else {
      this._player = new AudioPlayer(this._audioSource, audioSourcePath, loop, this._voiceEffect, normalizedSeekMs)
    }
    this._player.on('finish', () => { this._log('Video audio finished:', audioSourcePath) })
    this._player.on('error',  (err) => { this._log('Video audio error:', err.message); this.emit('error', err) })
    this._player.on('urlExpired',  (err) => { this._log('Video audio URL expired:', err.message); this.emit('videoUrlExpired', err) })
    this._player.start()

    this._player.pause()
    this._videoPlayer.pause()
    this._log(`Playing video audio: ${audioSourcePath} (both paused for coordinated start)`)

    this._announceVideoState({ enabled: true, videoType: type, reason: 'playVideo-start' })

    this._addVideoTrackToPeers()

    let playbackStartRequested = false
    const startPlayback = () => {
      if (playbackStartRequested) return
      playbackStartRequested = true
      if (!this._player || !this._videoPlayer) return

      const AUDIO_FRAME_BYTES = 480 * 2 * 2
      const audioBytes = this._player._buf?.length ?? 0
      const audioMs = (audioBytes / AUDIO_FRAME_BYTES) * 10

      const videoStatus = this._videoPlayer.getBufferStatus()
      const videoFrames = videoStatus?.bufferedFrames ?? 0
      const fps = this._videoPlayer._targetFPS || 30
      const videoMs = (videoFrames / fps) * 1000

      this._log(`Pre-start buffers — audio: ${audioMs.toFixed(0)}ms, video: ${videoMs.toFixed(0)}ms`)

      if (audioMs > videoMs + 20 && this._player._buf) {
        const targetAudioFrames = Math.max(1, Math.round(videoMs / 10))
        const keepBytes = targetAudioFrames * AUDIO_FRAME_BYTES
        const dropBytes = audioBytes - keepBytes
        if (dropBytes > 0) {
          this._player._buf = this._player._buf.slice(dropBytes)
          this._log(`Trimmed ${(dropBytes / AUDIO_FRAME_BYTES).toFixed(0)} audio frames to match video`)
        }
      } else if (videoMs > audioMs + 20) {
        const targetVideoFrames = Math.max(1, Math.round((audioMs / 1000) * fps))
        const frameSize = this._videoPlayer._width * this._videoPlayer._height * 3 / 2
        const dropFrames = videoFrames - targetVideoFrames
        if (dropFrames > 0 && this._videoPlayer._buf) {
          this._videoPlayer._buf = this._videoPlayer._buf.slice(dropFrames * frameSize)
          this._videoPlayer._bufferFrameCount = targetVideoFrames
          this._log(`Trimmed ${dropFrames} video frames to match audio`)
        }
      }

      const barrierTime = Date.now()
      this._videoPlayer.unpause(barrierTime)
      if (this._player && !this._player._stopped) {
        this._player.unpause(barrierTime)
      }
      this._log(`Started A/V on shared barrier`)
    }

    const startAt = Date.now()
    const waitForBothAndStart = () => {
      if (!this._videoPlayer || !this._player) return

      const videoStatus = this._videoPlayer.getBufferStatus()
      const videoFrames = videoStatus?.bufferedFrames ?? 0
      const videoInitialized = videoStatus?.initialized ?? false
      const audioBytes = this._player._buf?.length ?? 0

      if (videoFrames > 0 && audioBytes > 0 && videoInitialized) {
        this._log(`Both have frames and video initialized — balancing and starting`)
        startPlayback()
      } else if (Date.now() - startAt > 2000 && (audioBytes > 0 || videoFrames > 0 || videoInitialized)) {
        this._log(`Timeout fallback — starting with available buffers (audio=${audioBytes}, videoFrames=${videoFrames})`)
        startPlayback()
      } else if (Date.now() - startAt > 4000) {
        this._log(`Hard timeout fallback — unpausing pipeline to prevent freeze`)
        startPlayback()
      } else {
        setTimeout(waitForBothAndStart, 20)
      }
    }

    if (this._hasConnectedPeer()) {
      this._log('Peers already connected — waiting for both audio and video frames')
      waitForBothAndStart()
    } else {
      const onPeerJoin = () => {
        this._log('Peer joined — waiting for both audio and video frames')
        waitForBothAndStart()
      }
      this.once('peerJoin', onPeerJoin)
      setTimeout(() => {
        this.off('peerJoin', onPeerJoin)
        if (this._player && this._videoPlayer && this._player._paused && this._videoPlayer._paused) {
          this._log('Fallback: waiting for both audio and video frames')
          waitForBothAndStart()
        }
      }, 2000)
    }

    return Promise.resolve()
  }

  _hasVideoSender(pc) {
    if (!pc) return false
    return pc.getSenders().some(s => s.track?.kind === 'video')
  }

  _verifyNoVideoTracksSent() {
    if (this._videoPlaybackRequested) {
      console.log(`[Wire/Voice] Video is requested, skipping verification`)
      return true
    }
    
    let hasVideo = false
    for (const [peerId, ps] of this._peers.entries()) {
      if (!ps.pc) continue
      
      const videoSenders = ps.pc.getSenders().filter(s => s.track?.kind === 'video')
      if (videoSenders.length > 0) {
        console.log(`[Wire/Voice] WARNING: Found ${videoSenders.length} video sender(s) for peer ${peerId} when video is not requested`)
        hasVideo = true
      }
      
      const videoTransceivers = ps.pc.getTransceivers().filter(t => 
        t.sender?.track?.kind === 'video' && t.direction !== 'recvonly'
      )
      if (videoTransceivers.length > 0) {
        console.log(`[Wire/Voice] WARNING: Found ${videoTransceivers.length} video transceiver(s) with send capability for peer ${peerId} when video is not requested`)
        hasVideo = true
      }
    }
    
    if (!hasVideo) {
      console.log(`[Wire/Voice] Verified: No video tracks being sent (video not requested)`)
    }
    
    return !hasVideo
  }

  _addVideoTrackToPeers() {
    console.log(`[Wire/Voice] _addVideoTrackToPeers called - _videoPlaybackRequested: ${this._videoPlaybackRequested}, _videoTrack: ${!!this._videoTrack}, _videoStream: ${!!this._videoStream}, peers: ${this._peers.size}`)
    if (!this._videoTrack || !this._videoStream) {
      console.log(`[Wire/Voice] Skipping _addVideoTrackToPeers - missing track or stream`)
      return
    }
    
    for (const ps of this._peers.values()) {
      this._addVideoTrackToPeer(ps)
    }
  }

  _addVideoTrackToPeer(ps) {
    console.log(`[Wire/Voice] _addVideoTrackToPeer called for ${ps.peerId}`)
    console.log(`[Wire/Voice] Video track exists: ${!!this._videoTrack}, Video stream exists: ${!!this._videoStream}, PC exists: ${!!ps.pc}, Video requested: ${this._videoPlaybackRequested}`)
    
    if (!this._videoTrack || !this._videoStream || !ps.pc) {
      console.log(`[Wire/Voice] Cannot add video track to peer ${ps.peerId} - missing track=${!this._videoTrack}, stream=${!this._videoStream}, pc=${!ps.pc}`)
      return false
    }
    
    if (!this._videoPlaybackRequested) {
      console.log(`[Wire/Voice] Skipping video track addition to peer ${ps.peerId} - video not requested`)
      return false
    }
    
    // Debounce: prevent multiple simultaneous video track additions
    if (ps._addingVideoTrack) {
      console.log(`[Wire/Voice] Video track addition already in progress for ${ps.peerId}`)
      return false
    }
    
    // Check if connection is in a usable state
    const connState = ps.pc.connectionState
    const signalingState = ps.pc.signalingState
    const videoTrackId = this._videoTrack?.id || 'no-track'
    const preflightStateKey = `${videoTrackId}:${connState}:${signalingState}:${this._videoPlaybackRequested}`
    const now = Date.now()

    // Reconnect storms can trigger the same add attempt repeatedly while not ready.
    // Suppress duplicate preflight attempts until the state changes.
    if (connState !== 'connected' || signalingState !== 'stable') {
      if (
        ps._lastVideoAddPreflightKey === preflightStateKey &&
        now - (ps._lastVideoAddPreflightAt || 0) < 800
      ) {
        this._logThrottled(
          `video-add-preflight-skip:${ps.peerId}`,
          1000,
          `Skipping duplicate video add preflight for ${ps.peerId} (${connState}/${signalingState})`
        )
        return false
      }
      ps._lastVideoAddPreflightKey = preflightStateKey
      ps._lastVideoAddPreflightAt = now
    } else {
      ps._lastVideoAddPreflightKey = null
      ps._lastVideoAddPreflightAt = 0
    }

    console.log(`[Wire/Voice] Peer ${ps.peerId} connection state: ${connState}`)
    if (connState !== 'connected') {
      console.log(`[Wire/Voice] Peer ${ps.peerId} not connected (${connState}), will add video when connected`)
      return false
    }
    
    // Wait for stable signaling before modifying tracks
    if (signalingState !== 'stable') {
      console.log(`[Wire/Voice] Signaling not stable (${signalingState}) for ${ps.peerId}, queuing video track add`)
      ps.needsNegotiation = true
      return false
    }
    
    // Check if we already have this track added
    const existingSender = ps.pc.getSenders().find(s => s.track === this._videoTrack)
    if (existingSender) {
      console.log(`[Wire/Voice] Video track already added to peer ${ps.peerId}`)
      return true
    }
    
    ps._addingVideoTrack = true
    
    // Find existing video transceiver - this is the proper way to handle video track addition
    // We need to find a video transceiver and either replace its track or change its direction
    const transceivers = ps.pc.getTransceivers()
    const videoTransceiver = transceivers.find(t => t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video')
    
    console.log(`[Wire/Voice] Found ${transceivers.length} transceivers, video transceiver: ${!!videoTransceiver}`)
    
    if (videoTransceiver) {
      // Check if the transceiver already has our track
      if (videoTransceiver.sender?.track === this._videoTrack) {
        console.log(`[Wire/Voice] Video transceiver already has our track for ${ps.peerId}`)
        ps._addingVideoTrack = false
        return true
      }
      
      // If transceiver has no track or a different track, replace it
      if (videoTransceiver.sender) {
        try {
          // First, change direction to sendrecv if it's recvonly
          if (videoTransceiver.direction === 'recvonly') {
            console.log(`[Wire/Voice] Changing video transceiver direction from recvonly to sendrecv for ${ps.peerId}`)
            videoTransceiver.direction = 'sendrecv'
          }
          
          // Replace the track
          console.log(`[Wire/Voice] Replacing video track on existing transceiver for ${ps.peerId}`)
          videoTransceiver.sender.replaceTrack(this._videoTrack)
          
          // Set codec preferences on this transceiver
          try {
            const senderApi = this._RTCRtpSender
            const videoCaps = senderApi?.getCapabilities?.('video')?.codecs || []
            if (videoCaps.length > 0) {
              const vp8Codecs = videoCaps.filter(c => c.mimeType.toLowerCase() === 'video/vp8')
              const vp9Codecs = videoCaps.filter(c => c.mimeType.toLowerCase() === 'video/vp9')
              const h264Codecs = videoCaps.filter(c => c.mimeType.toLowerCase() === 'video/h264')
              const otherVideoCodecs = videoCaps.filter(c => 
                !['video/vp8', 'video/vp9', 'video/h264'].includes(c.mimeType.toLowerCase())
              )
              const sortedVideoCodecs = [...vp8Codecs, ...vp9Codecs, ...h264Codecs, ...otherVideoCodecs]
              videoTransceiver.setCodecPreferences(sortedVideoCodecs)
            }
          } catch (codecErr) {
            console.log(`[Wire/Voice] Failed to set codec preferences: ${codecErr.message}`)
          }
          
          console.log(`[Wire/Voice] Video track replaced on transceiver for ${ps.peerId} - triggering renegotiation`)
          this._setVideoBitrate(ps.pc)
          this._safeNegotiate(ps).then(() => {
            ps._addingVideoTrack = false
          }).catch(err => {
            console.log(`[Wire/Voice] Failed to renegotiate video track for ${ps.peerId}:`, err.message)
            ps._addingVideoTrack = false
          })
          return true
        } catch (err) {
          console.log(`[Wire/Voice] Error replacing video track on transceiver for ${ps.peerId}:`, err.message)
          ps._addingVideoTrack = false
        }
      }
    }
    
    // No existing video transceiver - use addTrack to add video and create a new transceiver
    if (!videoTransceiver) {
      console.log(`[Wire/Voice] No video transceiver found, adding video track to create one for ${ps.peerId}`)
      try {
        const sender = ps.pc.addTrack(this._videoTrack, this._videoStream)
        console.log(`[Wire/Voice] Added video track to peer ${ps.peerId}, sender: ${!!sender}`)
        this._setVideoBitrate(ps.pc)
        this._safeNegotiate(ps).then(() => {
          ps._addingVideoTrack = false
        }).catch(err => {
          console.log(`[Wire/Voice] Failed to renegotiate after addTrack for ${ps.peerId}:`, err.message)
          ps._addingVideoTrack = false
        })
        return true
      } catch (err) {
        console.log(`[Wire/Voice] Error adding video track for ${ps.peerId}:`, err.message)
        ps._addingVideoTrack = false
      }
    }
    
    console.log(`[Wire/Voice] No suitable transceiver or sender found for video track for ${ps.peerId}`)
    ps._addingVideoTrack = false
    return false
  }

  _removeVideoTrackFromPeer(ps) {
    if (!ps?.pc) return false
    const pc = ps.pc
    const videoSender = pc.getSenders().find(s => s.track?.kind === 'video')
    if (!videoSender) {
      console.log(`[Wire/Voice] No video sender found for peer ${ps.peerId}`)
      return false
    }

    console.log(`[Wire/Voice] Removing video track from peer ${ps.peerId}`)
    try { 
      videoSender.replaceTrack(null) 
    } catch {}

    // Set video transceiver direction back to recvonly to prevent black screen
    const videoTransceiver = pc.getTransceivers().find(t => 
      t.sender?.track?.kind === 'video' || t.receiver?.track?.kind === 'video'
    )
    if (videoTransceiver && videoTransceiver.direction !== 'recvonly') {
      this._log(`Setting video transceiver direction back to recvonly for ${ps.peerId}`)
      videoTransceiver.direction = 'recvonly'
    }

    this._log(`Removed video track sender for peer ${ps.peerId}`)
    
    // Always renegotiate after removing video to update the remote side
    this._safeNegotiate(ps).catch(err => {
      this._log(`Failed to renegotiate after removing video for ${ps.peerId}:`, err.message)
    })
    
    // Verify no video tracks are being sent after removal
    setTimeout(() => this._verifyNoVideoTracksSent(), 100)
    
    return true
  }

  stopVideo({ preservePlaybackRequest = false } = {}) {
    if (this._syncInterval) {
      clearInterval(this._syncInterval)
      this._syncInterval = null
    }
    if (this._peerMonitorInterval) {
      clearInterval(this._peerMonitorInterval)
      this._peerMonitorInterval = null
    }
    const videoType = this._videoType
    const wasTransitioning = this._videoTransitioning
    this._clearDualStreamStartup()

    if (this._dualStreamPlayer) { 
      this._dualStreamPlayer.stop(); 
      this._dualStreamPlayer = null 
    }
    this._dualStreamStarted = false
    if (this._videoPlayer) { this._videoPlayer.stop(); this._videoPlayer = null }
    if (this._player) { this._player.stop(); this._player = null }

    for (const ps of this._peers.values()) {
      this._removeVideoTrackFromPeer(ps)
    }

    if (this._videoTrack) { 
      try { this._videoTrack.stop() } catch {} 
      this._videoTrack = null 
    }
    if (this._videoSource) { this._videoSource = null }
    if (this._videoStream) { 
      try { this._videoStream.getTracks().forEach(t => t.stop()) } catch {} 
      this._videoStream = null 
    }
    this._videoType = null

    if (!wasTransitioning && this._socket?.connected && videoType) {
      this._announceVideoState({ enabled: false, videoType, reason: 'stopVideo' })
    }
    
    this._videoTransitioning = false
    if (preservePlaybackRequest) {
      console.log('[Wire/Voice] Video stopped during transition - preserving _videoPlaybackRequested')
    } else {
      this._videoPlaybackRequested = false
      console.log(`[Wire/Voice] Video stopped - resetting _videoPlaybackRequested = false`)
    }
    this._lastVideoAnnouncementKey = null
    
    // Verify no video tracks are being sent after stopping
    setTimeout(() => this._verifyNoVideoTracksSent(), 200)
  }

  _hasConnectedPeer() {
    for (const ps of this._peers.values()) {
      if (ps.pc?.connectionState === 'connected') return true
    }
    return false
  }

  _onPeerConnected() {
    console.log(`[Wire/Voice] _onPeerConnected called - _videoPlaybackRequested: ${this._videoPlaybackRequested}, _videoPlayer: ${!!this._videoPlayer}, _videoTrack: ${!!this._videoTrack}`)
    
    if (this._dualStreamPlayer && this._videoTrack) {
      this._addVideoTrackToPeers()
      this._requestDualStreamStart('peer-connected')
      return
    }

    if (this._player && this._player._paused && !this._player._stopped) {
      this._log(`Peer connected — starting audio`)
      this._player.unpause()
    }

    // Only start video on peer join if playVideo() was explicitly called and video is already unpaused/playing
    // Handle both regular VideoPlayer and DualStreamPlayer modes
    const isVideoPlaying = 
      (this._videoPlayer && this._videoTrack && !this._videoPlayer._paused && !this._videoPlayer._stopped) ||
      (this._dualStreamPlayer && this._videoTrack)
    
    if (this._videoPlaybackRequested && isVideoPlaying) {
      this._log(`Peer connected — starting video`)
      console.log(`[Wire/Voice] Peer connected - starting video playback (video was requested)`)
      if (this._videoPlayer) {
        this._videoPlayer.unpause()
      }
    } else {
      console.log(`[Wire/Voice] Peer connected - NOT starting video (requested: ${this._videoPlaybackRequested}, player: ${!!this._videoPlayer}, dualStream: ${!!this._dualStreamPlayer}, track: ${!!this._videoTrack})`)
    }
  }

  _resyncForPeerJoin(peerId) {
    if (this._dualStreamPlayer) {
      this._log(`Peer ${peerId} joined during DualStream playback - streams are already in sync`)
      return
    }
    
    if (!this._player || !this._videoPlayer) return
    if (this._player._stopped || this._videoPlayer._stopped) return

    if (this._player._paused || this._videoPlayer._paused) return

    const audioPos = this._player.getPosition ? this._player.getPosition() : 0
    this._log(`Peer ${peerId} joined during active video — forcing sync barrier at ${Math.round(audioPos)}ms`)

    try { this._player.pause() } catch {}
    try { this._videoPlayer.pause() } catch {}
    if (this._videoPlayer.resync) {
      try { this._videoPlayer.resync(audioPos) } catch {}
    }

    const barrierTime = Date.now()
    // Use shorter delay for faster sync response
    setTimeout(() => {
      if (!this._player || !this._videoPlayer) return
      if (this._player._stopped || this._videoPlayer._stopped) return
      this._player.unpause(barrierTime)
      this._videoPlayer.unpause(barrierTime)
    }, 80)
  }

  stopAudio() {
    if (this._player) { this._player.stop(); this._player = null }
  }

  seekAudio(positionMs = 0) {
    const targetMs = Math.max(0, Number(positionMs) || 0)
    if (!this._lastAudioPlayback?.source) {
      return Promise.reject(new Error('No active audio to seek'))
    }

    const req = this._lastAudioPlayback
    if (req.type === 'url') {
      return this.playUrl(req.source, {
        ...req.options,
        seekMs: targetMs,
      })
    }
    return this.playFile(req.source, {
      ...req.options,
      seekMs: targetMs,
    })
  }

  seekVideo(positionMs = 0) {
    const targetMs = Math.max(0, Number(positionMs) || 0)
    if (!this._lastVideoPlayback?.filePath) {
      return Promise.reject(new Error('No active video to seek'))
    }

    const req = this._lastVideoPlayback
    return this.playVideo(req.filePath, {
      ...req.options,
      seekMs: targetMs,
    })
  }

  setVoiceEffect(effect) {
    const oldEffect = { ...this._voiceEffect }
    
    if (typeof effect === 'string') {
      if (effect === 'none' || effect === 'off' || effect === 'reset') {
        this._voiceEffect = {
          enabled: false,
          type: 'none',
          pitch: 0,
          reverb: 0,
          distortion: 0,
          echo: 0,
          tremolo: 0,
          robot: false,
          alien: false
        }
        this._log('Voice effect reset')
      } else if (effect === 'robot') {
        this._voiceEffect = {
          enabled: true,
          type: 'robot',
          pitch: 0,
          reverb: 0,
          distortion: 0,
          echo: 0,
          tremolo: 0,
          robot: true,
          alien: false
        }
        this._log('Voice effect: robot')
      } else if (effect === 'alien') {
        this._voiceEffect = {
          enabled: true,
          type: 'alien',
          pitch: 0,
          reverb: 0,
          distortion: 0,
          echo: 0,
          tremolo: 0,
          robot: false,
          alien: true
        }
        this._log('Voice effect: alien')
      } else if (effect === 'echo') {
        this._voiceEffect = {
          enabled: true,
          type: 'echo',
          pitch: 0,
          reverb: 0,
          distortion: 0,
          echo: 0.5,
          tremolo: 0,
          robot: false,
          alien: false
        }
        this._log('Voice effect: echo')
      } else if (effect === 'reverb') {
        this._voiceEffect = {
          enabled: true,
          type: 'reverb',
          pitch: 0,
          reverb: 0.5,
          distortion: 0,
          echo: 0,
          tremolo: 0,
          robot: false,
          alien: false
        }
        this._log('Voice effect: reverb')
      } else if (effect === 'pitchup') {
        this._voiceEffect = {
          enabled: true,
          type: 'pitchup',
          pitch: 2,
          reverb: 0,
          distortion: 0,
          echo: 0,
          tremolo: 0,
          robot: false,
          alien: false
        }
        this._log('Voice effect: pitch up')
      } else if (effect === 'pitchdown') {
        this._voiceEffect = {
          enabled: true,
          type: 'pitchdown',
          pitch: -2,
          reverb: 0,
          distortion: 0,
          echo: 0,
          tremolo: 0,
          robot: false,
          alien: false
        }
        this._log('Voice effect: pitch down')
      } else {
        this._log(`Unknown effect: ${effect}`)
        return false
      }
    } else if (typeof effect === 'object') {
      this._voiceEffect = {
        ...this._voiceEffect,
        ...effect,
        enabled: true,
        type: effect.type || 'custom'
      }
      this._log('Voice effect updated:', this._voiceEffect)
    } else {
      this._log('Invalid effect parameter')
      return false
    }

    if (this._player && oldEffect.enabled !== this._voiceEffect.enabled) {
      this._log('Restarting player to apply effect change')
    }

    return true
  }

  getVoiceEffect() {
    return { ...this._voiceEffect }
  }

  setUseDualStream(enabled) {
    this._useDualStream = enabled
    this._log(`DualStream mode ${enabled ? 'enabled' : 'disabled'}`)
  }

  getUseDualStream() {
    return this._useDualStream
  }

  _buildAudioFilter() {
    const fx = this._voiceEffect
    if (!fx.enabled || fx.type === 'none') {
      return ''
    }

    const filters = []

    if (fx.pitch !== 0) {
      const rate = 48000
      const adjustedRate = rate * Math.pow(2, fx.pitch / 12)
      filters.push(`asetrate=r=${adjustedRate},aresample=${rate}`)
    }

    if (fx.reverb > 0) {
      const delay = 30
      const decay = fx.reverb
      filters.push(`aecho=0.8:0.9:${delay}:${decay}`)
    }

    if (fx.echo > 0) {
      filters.push(`aecho=0.8:0.88:${Math.floor(fx.echo * 60)}:0.4`)
    }

    if (fx.distortion > 0) {
      filters.push(`adistortion=threshold=${1 - fx.distortion * 0.5}:ratio=20:attack=5:release=50`)
    }

    if (fx.tremolo > 0) {
      filters.push(`tremolo=f=${5 + fx.tremolo * 10}:d=${fx.tremolo * 0.9}`)
    }

    if (fx.robot) {
      filters.push(`afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75`)
    }

    if (fx.alien) {
      filters.push(`afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.5`)
    }

    return filters.join(',')
  }

  leave() {
    this._log(`Leaving channel ${this._channelId}`)
    this.stopAudio()
    this.stopVideo()
    this._clearAllPeers()
    
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
    this._lastVideoAnnouncementKey = null
    this.removeAllListeners()
  }

  _isPolite(remoteId) {
    return this._botId < remoteId
  }

  _getOrCreatePeerState(remoteId) {
    let ps = this._peers.get(remoteId)

    if (!ps) {
      ps = new PeerState(remoteId, this._botId, this._isPolite(remoteId))
      this._peers.set(remoteId, ps)
    }

    if (!ps.pc || ps.pc.connectionState === 'closed' || ps.pc.connectionState === 'failed') {
      if (ps.pc) {
        try { ps.pc.close() } catch {}
      }
      ps.makingOffer       = false
      ps.ignoreOffer       = false
      ps.pendingCandidates = []
      ps.remoteDescSet     = false
      ps.needsNegotiation  = false
      ps.needsIceRestart   = false
      ps._peerJoinEmitted  = false
      ps._joinResyncDone   = false
      ps.pc = this._buildPeerConnection(ps)
    }

    return ps
  }

  _buildPeerConnection(ps) {
    this._log(`[Wire/Voice] Building peer connection with encryption: ${this._encrypted}`)
    
    const pcConfig = {
      sdpSemantics: 'unified-plan',
      iceServers:   this._iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 10,
      iceTransportPolicy: 'all',
    }
    
    // DTLS-SRTP is enabled by default in WebRTC when supported
    // The encryption is negotiated through SDP during the handshake
    // When encrypted is false, we allow unencrypted connections (not recommended)
    if (!this._encrypted) {
      this._log('[Wire/Voice] WARNING: Encryption disabled - voice will be unencrypted')
    }
    
    const pc = new this._RTCPeerConnection(pcConfig)

    ps._pendingIce = []

    // Use addTransceiver with tracks directly to avoid creating duplicate transceivers
    // This is the proper way for Chrome compatibility
    
    // Add audio transceiver with the track directly
    this._log(`Adding audio transceiver to peer ${ps.peerId}`)
    const audioTransceiver = pc.addTransceiver(this._audioTrack, {
      direction: 'sendrecv',
      streams: [this._audioStream]
    })
    this._log(`Audio transceiver added — sender exists: ${!!audioTransceiver?.sender}`)
    
    // Only add video transceiver if video playback was explicitly requested and track exists
    if (this._videoPlaybackRequested && this._videoTrack && this._videoStream) {
      console.log(`[Wire/Voice] Adding video transceiver with track to peer ${ps.peerId} (video requested: ${this._videoPlaybackRequested})`)
      const videoTransceiver = pc.addTransceiver(this._videoTrack, {
        direction: 'sendrecv',
        streams: [this._videoStream]
      })
      console.log(`[Wire/Voice] Video transceiver added — sender exists: ${!!videoTransceiver?.sender}`)
    } else {
      console.log(`[Wire/Voice] No video transceiver added for peer ${ps.peerId} - video not requested: ${this._videoPlaybackRequested}, track: ${!!this._videoTrack}, stream: ${!!this._videoStream}`)
    }
    
    // Set codec preferences AFTER all transceivers are created
    this._setCodecPreferences(pc)

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
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        this._log(`ICE ${pc.iceConnectionState} for ${ps.peerId} — attempting ICE restart`)
        this._restartIce(ps)
      }
    }

    pc.onconnectionstatechange = () => {
      this._log(`Peer ${ps.peerId} connection state: ${pc.connectionState}`)
      this._reportPeerState(ps.peerId, pc.connectionState)
      
      if (pc.connectionState === 'connected') {
        this._setAudioQuality(pc, 192000)
        // Set high video bitrate for better resolution
        if (this._videoTrack) {
          this._setVideoBitrate(pc)
        }

        // Add video track to this peer ONLY if video playback was explicitly requested
        if (this._videoPlaybackRequested && this._videoTrack && this._videoStream) {
          this._log(`Peer ${ps.peerId} connected - adding video track (video requested)`)
          this._addVideoTrackToPeer(ps)

          // Also start video playback if bot is playing video
          if (this._videoPlayer && this._videoPlayer._paused && !this._videoPlayer._stopped) {
            this._log(`Peer ${ps.peerId} connected - resuming video for new peer`)
            this._videoPlayer.unpause()
          }

          // Announce video state to this peer so they know we're screen sharing
          // Use a small delay to ensure the connection is fully established
          setTimeout(() => {
            this._announceVideoStateToPeer(ps.peerId)
          }, 500)
        } else {
          this._log(`Peer ${ps.peerId} connected - skipping video track (video not requested)`)
        }
        
        if (!ps._peerJoinEmitted) {
          ps._peerJoinEmitted = true
          this._onPeerConnected()
          this.emit('peerJoin', ps.peerId)
        }

        if (this._videoPlayer && this._player && !ps._joinResyncDone) {
          ps._joinResyncDone = true
        }
      } else if (pc.connectionState === 'connecting' || pc.connectionState === 'disconnected') {
        ps._joinResyncDone = false
      }
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this._destroyPeerState(ps.peerId)
      }
    }

    pc.onnegotiationneeded = async () => {
      if (ps.makingOffer) {
        this._log(`Skipping onnegotiationneeded for ${ps.peerId} — offer already in flight`)
        ps.needsNegotiation = true
        return
      }
      if (pc.signalingState !== 'stable') {
        this._log(`Skipping onnegotiationneeded for ${ps.peerId} — signalingState: ${pc.signalingState}`)
        ps.needsNegotiation = true
        return
      }
      this._safeNegotiate(ps).catch(err => {
        this._log(`onnegotiationneeded error for ${ps.peerId}:`, err.message)
      })
    }

    pc.onsignalingstatechange = () => {
      if (pc.signalingState === 'stable') {
        this._flushPendingNegotiation(ps)
      }
    }

    return pc
  }

  async _negotiate(ps, { iceRestart = false } = {}) {
    console.log(`[Wire/Voice] _negotiate called for ${ps?.peerId}, iceRestart=${iceRestart}`)
    if (!ps?.pc) {
      console.log(`[Wire/Voice] _negotiate: no pc for ${ps?.peerId}`)
      return
    }
    if (!this._canNegotiate(ps)) {
      console.log(`[Wire/Voice] _negotiate: cooldown active for ${ps.peerId}, skipping`)
      return
    }
    if (ps.makingOffer) {
      console.log(`[Wire/Voice] _negotiate: already making offer for ${ps.peerId}, queuing`)
      ps.needsNegotiation = true
      ps.needsIceRestart = ps.needsIceRestart || !!iceRestart
      return
    }
    if (ps.pc.signalingState !== 'stable') {
      console.log(`[Wire/Voice] _negotiate: signaling state not stable for ${ps.peerId} (${ps.pc.signalingState}), queuing`)
      ps.needsNegotiation = true
      ps.needsIceRestart = ps.needsIceRestart || !!iceRestart
      return
    }

    const shouldIceRestart = !!iceRestart || !!ps.needsIceRestart
    console.log(`[Wire/Voice] _negotiate: creating offer for ${ps.peerId}, iceRestart=${shouldIceRestart}`)
    
    // Log the tracks being sent
    const senders = ps.pc.getSenders()
    console.log(`[Wire/Voice] _negotiate: ${senders.length} senders for ${ps.peerId}`)
    senders.forEach((s, i) => {
      console.log(`[Wire/Voice] _negotiate: sender ${i} track=${s.track?.kind || 'null'}`)
    })
    
    try {
      ps.makingOffer = true
      ps.needsNegotiation = false
      ps.needsIceRestart = false
      const offer = await ps.pc.createOffer({ iceRestart: shouldIceRestart })
      if (ps.pc.signalingState !== 'stable') {
        throw new Error(`signaling-state-changed:${ps.pc.signalingState}`)
      }
      const tunedOffer = this._enhanceOpusSdp(offer)
      console.log(`[Wire/Voice] _negotiate: offer created for ${ps.peerId}, sdp type=${offer.type}`)
      await ps.pc.setLocalDescription(tunedOffer)
      this._socket.emit('voice:offer', {
        to:        ps.peerId,
        offer:     ps.pc.localDescription,
        channelId: this._channelId,
      })
      console.log(`[Wire/Voice] Sent ${shouldIceRestart ? 'ICE-restart ' : ''}offer to ${ps.peerId}`)
    } catch (err) {
      if (String(err?.message || '').startsWith('signaling-state-changed:')) {
        console.log(`[Wire/Voice] Negotiation deferred for ${ps.peerId}:`, err.message)
      } else {
        console.log(`[Wire/Voice] Negotiation failed for ${ps.peerId}:`, err.message)
      }
      ps.needsNegotiation = true
      ps.needsIceRestart = ps.needsIceRestart || shouldIceRestart
    } finally {
      ps.makingOffer = false
      if (ps.pc?.signalingState === 'stable') {
        this._flushPendingNegotiation(ps)
      }
    }
  }

  async _restartIce(ps) {
    return this._safeNegotiate(ps, true)
  }

  _flushPendingNegotiation(ps) {
    if (!ps?.pc || ps.makingOffer || ps.pc.signalingState !== 'stable') return
    if (!ps.needsNegotiation && !ps.needsIceRestart) return
    const needsRestart = !!ps.needsIceRestart
    ps.needsNegotiation = false
    ps.needsIceRestart = false
    this._safeNegotiate(ps, needsRestart).catch(err => {
      this._log(`Deferred negotiation failed for ${ps.peerId}:`, err.message)
    })
  }

  _destroyPeerState(remoteId) {
    const ps = this._peers.get(remoteId)
    if (!ps) return
    
    console.log(`[Wire/Voice] Destroying peer state for ${remoteId}`)
    
    // Remove video track from this peer before closing the connection
    if (ps.pc && this._videoTrack) {
      this._removeVideoTrackFromPeer(ps)
    }
    
    if (ps.pc) { 
      try { 
        ps.pc.close() 
        console.log(`[Wire/Voice] Peer connection closed for ${remoteId}`)
      } catch (err) {
        console.log(`[Wire/Voice] Error closing peer connection for ${remoteId}:`, err.message)
      } 
    }
    this._peers.delete(remoteId)
    console.log(`[Wire/Voice] Peer state destroyed for ${remoteId}, remaining peers: ${this._peers.size}`)
  }

  _clearAllPeers() {
    for (const remoteId of [...this._peers.keys()]) {
      this._destroyPeerState(remoteId)
    }
  }

  _registerSocketListeners() {
    this._socket.on('voice:participants',  this._onParticipants)
    this._socket.on('voice:user-joined',   this._onUserJoined)
    this._socket.on('voice:user-left',     this._onUserLeft)
    this._socket.on('voice:user-reconnected', this._onUserReconnected)
    this._socket.on('voice:user-updated',  this._onUserUpdated)
    this._socket.on('voice:video-update',   this._onVideoUpdate)
    this._socket.on('voice:screen-share-update', this._onScreenShareUpdate)
    this._socket.on('voice:offer',         this._onOffer)
    this._socket.on('voice:answer',        this._onAnswer)
    this._socket.on('voice:ice-candidate', this._onIceCandidate)
    this._socket.on('voice:force-reconnect', this._onForceReconnect)
    this._socket.on('voice:resync-request', this._onResyncRequest)
    this._socket.on('connect', this._onSocketConnect)
    if (this._debug) {
      this._socket.onAny(this._onAnyDebug)
    }
  }

  _deregisterSocketListeners() {
    this._socket.off('voice:participants',  this._onParticipants)
    this._socket.off('voice:user-joined',   this._onUserJoined)
    this._socket.off('voice:user-left',     this._onUserLeft)
    this._socket.off('voice:user-reconnected', this._onUserReconnected)
    this._socket.off('voice:user-updated',  this._onUserUpdated)
    this._socket.off('voice:video-update',   this._onVideoUpdate)
    this._socket.off('voice:screen-share-update', this._onScreenShareUpdate)
    this._socket.off('voice:offer',         this._onOffer)
    this._socket.off('voice:answer',        this._onAnswer)
    this._socket.off('voice:ice-candidate', this._onIceCandidate)
    this._socket.off('voice:force-reconnect', this._onForceReconnect)
    this._socket.off('voice:resync-request', this._onResyncRequest)
    this._socket.off('connect', this._onSocketConnect)
    if (this._socket.offAny) {
      this._socket.offAny(this._onAnyDebug)
    }
  }

  // Handle resync requests from clients - resync our media timing with them
  _onResyncRequest(data) {
    const { from, channelId } = data
    if (channelId && channelId !== this._channelId) return
    
    this._log(`Resync requested by peer: ${from}`)
    
    // Resync video player if active to match audio timing
    if (this._videoPlayer && this._videoPlayer.resync) {
      this._log(`Resyncing video player for peer: ${from}`)
      const audioPos = this._player ? this._player.getPosition() : null
      this._videoPlayer.resync(audioPos)
    }
    
    // Also trigger renegotiation to ensure fresh connection
    const ps = this._peers.get(from)
    if (ps && ps.pc && ps.pc.connectionState === 'connected') {
      this._log(`Triggering renegotiation for resync with: ${from}`)
      this._restartIce(ps).catch(err => {
        this._log(`Resync renegotiation failed:`, err.message)
      })
    } else {
      // If no specific peer or peer not connected, try to sync with all peers
      this._resyncAllPeers()
    }
  }
  
  _resyncAllPeers() {
    if (!this._player || !this._videoPlayer) return
    if (this._player._paused || this._videoPlayer._paused) return
    
    const audioPos = this._player.getPosition ? this._player.getPosition() : 0
    this._log(`Syncing all peers to audio position: ${Math.round(audioPos)}ms`)
    
    // Pause both briefly and resync
    try { this._player.pause() } catch {}
    try { this._videoPlayer.pause() } catch {}
    
    if (this._videoPlayer.resync) {
      try { this._videoPlayer.resync(audioPos) } catch {}
    }
    
    const barrierTime = Date.now()
    setTimeout(() => {
      if (this._player && this._videoPlayer) {
        this._player.unpause(barrierTime)
        this._videoPlayer.unpause(barrierTime)
      }
    }, 50)
  }

  _onParticipants({ channelId, participants }) {
    if (channelId !== this._channelId) return
    const peerIds = (participants || [])
      .map(p => p.id || p)
      .filter(pid => pid && pid !== this._botId)
    
    this._log(`Existing participants: ${peerIds.length} peers`)
    
    if (peerIds.length > 10) {
      this._isMassJoinInProgress = true
      this._pendingPeerCount = peerIds.length
    }
    
    const tier = this._getTierConfig()
    const baseDelay = tier.staggerBase
    const staggerMs = tier.staggerPerPeer
    
    peerIds.forEach((pid, index) => {
      const delay = baseDelay + (index * staggerMs) + (Math.random() * 200)
      this._log(`Queuing connection to ${pid} in ${Math.round(delay)}ms`)
      setTimeout(() => this._queueConnection(pid), delay)
    })
  }

  _processPeerBatches(peerIds) {
    const tier = this._getTierConfig()
    const batchSize = Math.min(tier.maxPeers, 20)
    const batches = []
    
    for (let i = 0; i < peerIds.length; i += batchSize) {
      batches.push(peerIds.slice(i, i + batchSize))
    }
    
    this._log(`Split ${peerIds.length} peers into ${batches.length} batches`)
    
    batches.forEach((batch, batchIndex) => {
      const batchDelay = batchIndex * 5000
      
      setTimeout(() => {
        this._log(`Processing batch ${batchIndex + 1}/${batches.length}`)
        
        batch.forEach((pid, index) => {
          if (!this._canAcceptPeer(pid)) return
          
          const delay = tier.staggerBase + (index * tier.staggerPerPeer) + (Math.random() * 200)
          setTimeout(() => this._queueConnection(pid), delay)
        })
        
        if (batchIndex === batches.length - 1) {
          setTimeout(() => {
            this._isMassJoinInProgress = false
            this._pendingPeerCount = 0
          }, 10000)
        }
      }, batchDelay)
    })
  }

  _onUserJoined(userInfo) {
    const userId = userInfo?.id || userInfo?.userId
    if (!userId || userId === this._botId) return
    this._log('User joined voice:', userId)
    
    if (!this._canAcceptPeer(userId)) {
      this._log(`Cannot accept peer ${userId}: at capacity`)
      return
    }
    
    const tier = this._getTierConfig()
    const peerCount = this._peers.size
    const delay = tier.staggerBase + (peerCount * tier.staggerPerPeer * 0.5) + (Math.random() * 300)
    setTimeout(() => this._queueConnection(userId), delay)
    
    // Announce video state to the new user after connection is established
    // This ensures new joiners see the bot's screen share/video
    if (this._videoTrack && this._videoType) {
      setTimeout(() => {
        this._announceVideoStateToPeer(userId)
      }, delay + 2000)  // Wait longer for connection to be established
    }
  }

  _onUserLeft(data) {
    const userId = data?.userId || data?.id
    if (!userId || userId === this._botId) return
    this._log('User left voice:', userId)
    console.log(`[Wire/Voice] User ${userId} left voice - cleaning up peer state and video tracks`)
    this._destroyPeerState(userId)
    this.emit('peerLeave', userId)
  }

  _onUserReconnected(userInfo) {
    const userId = userInfo?.id || userInfo?.userId
    if (!userId || userId === this._botId) return
    this._log('User reconnected to voice:', userId)
    
    // Destroy existing peer state and reconnect
    this._destroyPeerState(userId)
    
    if (!this._canAcceptPeer(userId)) {
      this._log(`Cannot accept reconnected peer ${userId}: at capacity`)
      return
    }
    
    const tier = this._getTierConfig()
    const delay = tier.staggerBase + (Math.random() * 200)
    setTimeout(() => this._queueConnection(userId), delay)
    
    // Re-announce video state to the reconnected user after a short delay
    // This ensures they receive the current screen share/video state
    if (this._videoTrack && this._videoType) {
      setTimeout(() => {
        this._announceVideoStateToPeer(userId)
      }, delay + 1000)
    }
  }
  
  // Announce current video state to a specific peer (for reconnections)
  _announceVideoStateToPeer(peerId) {
    if (!this._socket?.connected || !this._videoType) return
    
    const eventName = this._getVideoSignalEvent(this._videoType)
    if (!eventName) return
    
    // Send directly to the specific peer
    this._socket.emit(eventName, {
      channelId: this._channelId,
      userId: this._botId,
      enabled: true,
      targetPeerId: peerId,  // Target specific peer
    })
    
    // Also emit the update event
    const updateEventName = this._videoType === 'screen' ? 'voice:screen-share-update' : 'voice:video-update'
    this._socket.emit(updateEventName, {
      channelId: this._channelId,
      userId: this._botId,
      enabled: true,
      type: this._videoType,
      videoType: this._videoType,
      targetPeerId: peerId,  // Target specific peer
    })
    
    this._log(`Announced video state to peer ${peerId} (type: ${this._videoType})`)
  }

  _onUserUpdated(data) {
    const { userId, channelId, hasVideo, hasScreenShare, isMuted, isDeafened, isSelfMuted, isSelfDeafened } = data
    if (channelId !== this._channelId) return
    if (userId === this._botId) return
    
    this._log(`User ${userId} updated: video=${hasVideo}, screen=${hasScreenShare}, muted=${isMuted}`)
    
    // Emit event for external handlers (like Wilmer bot)
    this.emit('peerUpdate', { peerId: userId, hasVideo, hasScreenShare, isMuted, isDeafened, isSelfMuted, isSelfDeafened })
  }

  _onVideoUpdate(data) {
    const { userId, channelId, enabled, videoType } = data
    if (channelId !== this._channelId) return
    if (userId === this._botId) return
    
    this._log(`User ${userId} video ${enabled ? 'enabled' : 'disabled'} (type: ${videoType})`)
    
    // Emit event for external handlers
    this.emit('peerVideoUpdate', { peerId: userId, enabled, videoType })
    
    // If video was disabled, we might need to resync
    if (!enabled && this._videoPlayer) {
      this._log(`Peer ${userId} disabled video - triggering resync`)
      this._resyncAllPeers()
    }
  }

  _onScreenShareUpdate(data) {
    const { userId, channelId, enabled, type } = data
    if (channelId !== this._channelId) return
    if (userId === this._botId) return
    
    this._log(`User ${userId} screen share ${enabled ? 'enabled' : 'disabled'} (type: ${type})`)
    
    // Emit event for external handlers
    this.emit('peerScreenShareUpdate', { peerId: userId, enabled, type })
    
    // If screen share was disabled, we might need to resync
    if (!enabled && this._videoPlayer) {
      this._log(`Peer ${userId} disabled screen share - triggering resync`)
      this._resyncAllPeers()
    }
  }

  _onForceReconnect(data) {
    const { channelId, reason, targetPeer, failurePercent, timestamp } = data
    if (channelId !== this._channelId) return
    
    this._log(`Force-reconnect received: ${reason}, target=${targetPeer}`)
    
    if (targetPeer === this._botId) {
      this._log('Bot targeted for reconnect - rebuilding peer connections')
      for (const peerId of [...this._peers.keys()]) {
        this._destroyPeerState(peerId)
        this._queueConnection(peerId)
      }
    } else if (targetPeer === 'all' || targetPeer === '*') {
      this._log('Full channel reconnect requested')
    } else {
      this._log(`Reconnecting to specific peer ${targetPeer}`)
      this._destroyPeerState(targetPeer)
      this._queueConnection(targetPeer)
    }
  }

  _queueConnection(remoteId) {
    if (!this._canAcceptPeer(remoteId)) {
      this._log(`Cannot queue ${remoteId}: at capacity`)
      return
    }

    const tier = this._getTierConfig()
    const lastAttempt = this._connectionCooldowns.get(remoteId)
    if (lastAttempt && Date.now() - lastAttempt < tier.cooldown) {
      this._log(`Connection to ${remoteId} on cooldown, skipping`)
      return
    }

    if (this._connectionQueue.includes(remoteId)) {
      this._log(`Connection to ${remoteId} already queued`)
      return
    }

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

  async _processConnectionQueue() {
    if (this._isConnecting) return
    this._isConnecting = true

    const tier = this._getTierConfig()
    const maxConcurrent = tier.concurrent

    while (this._connectionQueue.length > 0 && this._activeNegotiations < maxConcurrent) {
      const remoteId = this._connectionQueue.shift()
      
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
      
      try {
        this._offerTo(remoteId)
      } catch (err) {
        this._log(`Error initiating connection to ${remoteId}:`, err.message)
        this._activeNegotiations = Math.max(0, this._activeNegotiations - 1)
      }

      if (this._connectionQueue.length > 0) {
        const delay = tier.staggerPerPeer
        await new Promise(r => setTimeout(r, delay))
      }
    }

    this._isConnecting = false
    
    if (this._connectionQueue.length > 0) {
      setTimeout(() => this._processConnectionQueue(), tier.staggerBase)
    }
  }

  _offerTo(remoteId) {
    const existing = this._peers.get(remoteId)
    if (existing) {
      const state = existing.pc?.connectionState
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
    
    setTimeout(() => {
      this._activeNegotiations = Math.max(0, this._activeNegotiations - 1)
      this._processConnectionQueue()
    }, 3000)
  }

  async _onOffer({ from, offer, channelId }) {
    if (channelId !== this._channelId) return
    this._log(`Received offer from ${from}`)

    const ps = this._getOrCreatePeerState(from)
    const pc = ps.pc

    const offerCollision = ps.makingOffer || pc.signalingState !== 'stable'

    ps.ignoreOffer = !ps.polite && offerCollision
    if (ps.ignoreOffer) {
      this._log(`Ignoring colliding offer from ${from} (impolite)`)
      return
    }

    try {
      if (offerCollision) {
        this._log(`Polite peer rolling back for ${from}`)
        await pc.setLocalDescription({ type: 'rollback' })
        ps.makingOffer = false
      }

      await pc.setRemoteDescription(new this._RTCSessionDescription(offer))
      ps.remoteDescSet = true

      await this._flushPendingIce(ps)

      const answer = await pc.createAnswer()
      const tunedAnswer = this._enhanceOpusSdp(answer)
      await pc.setLocalDescription(tunedAnswer)

      this._socket.emit('voice:answer', {
        to:        from,
        answer:    pc.localDescription,
        channelId: this._channelId,
      })
      this._log(`Sent answer to ${from}`)

      this._pollForConnected(ps)
      this._flushPendingNegotiation(ps)
    } catch (err) {
      this._log(`Failed to handle offer from ${from}:`, err.message)
      this.emit('error', err)
    }
  }

  async _onAnswer({ from, answer, channelId }) {
    if (channelId && channelId !== this._channelId) return
    const ps = this._peers.get(from)
    if (!ps?.pc) return
    if (ps.pc.signalingState === 'stable') return

    try {
      await ps.pc.setRemoteDescription(new this._RTCSessionDescription(answer))
      ps.remoteDescSet = true
      ps.ignoreOffer = false
      this._log(`Set remote answer from ${from}`)
      await this._flushPendingIce(ps)
      this._pollForConnected(ps)
      this._flushPendingNegotiation(ps)
    } catch (err) {
      if (!ps.ignoreOffer) {
        this._log(`Failed to set answer from ${from}:`, err.message)
      }
    }
  }

  async _flushCandidates(ps) {
    if (!ps.pc) return
    for (const candidate of ps.pendingCandidates) {
      try {
        await ps.pc.addIceCandidate(new this._RTCIceCandidate(candidate))
      } catch (err) {
        this._log(`Error adding ICE candidate:`, err.message)
      }
    }
    ps.pendingCandidates = []
  }

  _pollForConnected(ps, attempts = 0) {
    const MAX = 40
    if (attempts >= MAX) {
      this._log(`Poll timed out for ${ps.peerId} — forcing unpause`)
      this._onPeerConnected()
      return
    }
    setTimeout(() => {
      if (!ps.pc) return
      if (ps.pc.connectionState === 'connected') {
        this._log(`Poll detected connected for ${ps.peerId}`)
        if (!ps._peerJoinEmitted) {
          ps._peerJoinEmitted = true
          this._onPeerConnected()
          this.emit('peerJoin', ps.peerId)
        }
        return
      }
      this._pollForConnected(ps, attempts + 1)
    }, 250)
  }

  _onIceCandidate({ from, candidate, channelId }) {
    if (channelId !== this._channelId) return
    const ps = this._peers.get(from)
    if (!ps || !ps.pc) return

    this._addIceCandidate(ps, new this._RTCIceCandidate(candidate))
  }
}
