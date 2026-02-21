import { EventEmitter } from './EventEmitter.js'
import { createRequire } from 'module'
import { spawn } from 'child_process'
import { spawnSync } from 'child_process'
import path from 'path'
import fs from 'fs'

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

const SAMPLE_RATE    = 48000
const CHANNELS       = 1
const BITS           = 16
const FRAME_DURATION = 10
const FRAME_SAMPLES  = (SAMPLE_RATE * FRAME_DURATION) / 1000
const FRAME_BYTES    = FRAME_SAMPLES * CHANNELS * (BITS / 8)

const VIDEO_WIDTH   = 640
const VIDEO_HEIGHT  = 360
const VIDEO_FPS      = 30
const LOW_LATENCY_MAX_VIDEO_BUFFER_FRAMES = 8
const LOW_LATENCY_START_BUFFER_FRAMES = 2
const LOW_LATENCY_START_DELAY_MS = 0
const LOW_LATENCY_RESUME_DELAY_MS = 100
const LOW_LATENCY_RESYNC_DELAY_MS = 120
const LOW_LATENCY_MAX_CORRECTION_DELAY_MS = 25
const RTC_DELAY_MS = 0
const MAX_PLAYER_RETRY_ATTEMPTS = 3
const MAX_STREAM_BUFFER_FRAMES = 48
const MAX_STREAM_TARGET_BUFFER_FRAMES = 6
const MAX_VIDEO_BUFFER_FRAMES = 240
const MAX_VIDEO_TARGET_BUFFER_FRAMES = 4
const FFMPEG_RETRY_BACKOFF_MS = 1200

function parseFpsValue(raw) {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '0/0') return null
  if (trimmed.includes('/')) {
    const [n, d] = trimmed.split('/').map(Number)
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null
    const fps = n / d
    return Number.isFinite(fps) && fps > 1 && fps < 240 ? fps : null
  }
  const fps = Number(trimmed)
  return Number.isFinite(fps) && fps > 1 && fps < 240 ? fps : null
}

function detectInputFpsSync(input, isUrl = false) {
  try {
    const args = ['-v', 'error']
    if (isUrl) {
      args.push(
        '-rw_timeout', '8000000',
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
    }
    args.push(
      '-select_streams', 'v:0',
      '-show_entries', 'stream=avg_frame_rate,r_frame_rate',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      input
    )
    const result = spawnSync('ffprobe', args, { encoding: 'utf8', timeout: isUrl ? 5000 : 3000 })
    if (result.error || result.status !== 0) return null
    const lines = (result.stdout || '').split('\n').map(l => l.trim()).filter(Boolean)
    for (const line of lines) {
      const fps = parseFpsValue(line)
      if (fps) return fps
    }
    return null
  } catch {
    return null
  }
}

function isHttpInput(input) {
  return typeof input === 'string' && /^(https?):\/\//i.test(input.trim())
}

function sanitizeMediaInput(input) {
  const normalized = typeof input === 'string' ? input.trim() : ''
  if (!normalized) return null
  if (isHttpInput(normalized)) return normalized
  return normalized
}

function buildHttpInputArgs(input, userAgent) {
  const headers = [
    'User-Agent: ' + userAgent,
    'Accept: */*',
    'Accept-Language: en-US,en;q=0.9',
    'Connection: keep-alive'
  ]

  return [
    '-rw_timeout', '15000000',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '8',
    '-user_agent', userAgent,
    '-headers', headers.join('\r\n') + '\r\n',
    '-i', input
  ]
}

function buildAudioFilter(effect) {
  if (!effect || !effect.enabled || effect.type === 'none') return null
  
  const filters = []
  
  if (effect.pitch !== 0) {
    const speed = Math.pow(2, effect.pitch / 12)
    filters.push(`atempo=${speed}`)
  }
  
  if (effect.reverb > 0) {
    filters.push(`aecho=0.8:0.9:${effect.reverb / 100}:0.5`)
  }
  
  if (effect.distortion > 0) {
    filters.push(`acompressor=threshold=-20dB:ratio=4:attack=5:release=50`)
  }
  
  if (effect.echo > 0) {
    filters.push(`aecho=0.8:0.88:${effect.echo / 200}:0.4`)
  }
  
  if (effect.tremolo > 0) {
    filters.push(`vibrato=f=${effect.tremolo / 10}:d=0.5`)
  }
  
  if (effect.robot) {
    filters.push(`afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75`)
  }
  
  if (effect.alien) {
    filters.push(`afftfilt=real='cosh(0)*sin(0)':imag='cosh(0)*cos(0)':win_size=512:overlap=0.75`)
  }
  
  return filters.length > 0 ? filters.join(',') : null
}

class AudioPlayer extends EventEmitter {
  constructor(audioSource, filePath, loop = false, effect = null) {
    super()
    this._source     = audioSource
    this._filePath   = filePath
    this._loop       = loop
    this._effect     = effect || { enabled: false, type: 'none', pitch: 0, reverb: 0, distortion: 0, echo: 0, tremolo: 0, robot: false, alien: false }
    this._ffmpeg     = null
    this._timer      = null
    this._buf        = Buffer.alloc(0)
    this._stopped    = false
    this._paused     = true
    this._volume     = 1.0
    this._framesSent = 0
    this._startTime  = null
    this._pausedTime = 0
    this._pauseStart = null
    this._bufferFrameCount = 0
    this._maxBufferFrames = LOW_LATENCY_MAX_VIDEO_BUFFER_FRAMES
  }

  start() {
    this._stopped    = false
    this._paused     = true
    this._framesSent = 0
    this._startTime  = null
    this._pausedTime = 0
    this._pauseStart = null
    this._bufferFrameCount = 0
    this._spawnFfmpeg()
  }

  _spawnFfmpeg() {
    if (this._stopped) return
    if (!fs.existsSync(this._filePath)) {
      this.emit('error', new Error(`Audio file not found: ${this._filePath}`))
      return
    }
    
    const args = [
      '-re',
      '-loglevel', 'warning',
      '-i', this._filePath,
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
    ]

    const filter = buildAudioFilter(this._effect)
    if (filter) {
      const outputIndex = args.indexOf('-f')
      args.splice(outputIndex > 0 ? outputIndex : args.length, 0, '-af', filter)
    }

    args.push('pipe:1')

    this._ffmpeg = spawn('ffmpeg', args)

    const frameSize = FRAME_BYTES
    this._ffmpeg.stdout.on('data', (chunk) => {
      this._buf = Buffer.concat([this._buf, chunk])
      const maxStartupFrames = Math.max(1, LOW_LATENCY_START_BUFFER_FRAMES)
      const frameLimit = this._paused && !this._startTime
        ? maxStartupFrames
        : (this._paused ? this._maxBufferFrames : null)
      if (this._paused) {
        this._bufferFrameCount = Math.floor(this._buf.length / frameSize)
      }
      if (frameLimit) {
        const maxBytes = frameSize * frameLimit
        if (this._buf.length > maxBytes) {
          this._buf = this._buf.slice(this._buf.length - maxBytes)
          this._bufferFrameCount = frameLimit
        }
      }
    })

    this._ffmpeg.stderr.on('data', (d) => {
      const msg = d.toString().trim()
      if (msg) console.warn('[Wire/Voice/Audio] ffmpeg:', msg)
    })

    this._ffmpeg.on('close', (code) => {
      console.log(`[Wire/Voice/Audio] ffmpeg closed (code=${code})`)
      if (!this._stopped && this._loop) {
        this._buf = Buffer.alloc(0)
        this._spawnFfmpeg()
      } else {
        this._drainAndFinish()
      }
    })

    this._ffmpeg.on('error', (err) => {
      console.error('[Wire/Voice/Audio] ffmpeg error:', err.message)
      this.emit('error', err)
    })
  }

  unpause(baseStartTime = null) {
    if (!this._paused) return
    const now = Number.isFinite(baseStartTime) ? baseStartTime : Date.now()
    this._paused = false
    if (this._pauseStart) {
      this._pausedTime += now - this._pauseStart
      this._pauseStart = null
    }
    if (!this._startTime) {
      this._startTime = now
    }
    if (!this._timer && !this._stopped) {
      this._timer = setInterval(() => this._pump(), FRAME_DURATION)
    }
  }

  pause() {
    this._paused = true
    this._pauseStart = Date.now()
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  getPosition() {
    if (!this._startTime || this._paused) return 0
    
    // RTC has ~100ms inherent delay, use wall clock for first 3 seconds
    // then switch to frame count to prevent drift
    const elapsedMs = Date.now() - this._startTime - this._pausedTime
    
    if (elapsedMs < 3000) {
      // Initial phase: use wall clock (accurate at start)
      return elapsedMs + RTC_DELAY_MS
    } else {
      // Steady state: use frame count to prevent drift
      const msPosition = (this._framesSent * FRAME_SAMPLES) / SAMPLE_RATE * 1000 + RTC_DELAY_MS
      return msPosition
    }
  }

  _pump() {
    if (this._stopped || this._paused) return
    if (this._buf.length < FRAME_BYTES) return

    const frameData = Buffer.alloc(FRAME_BYTES)
    this._buf.copy(frameData, 0, 0, FRAME_BYTES)
    this._buf = this._buf.slice(FRAME_BYTES)

    let samples = new Int16Array(frameData.buffer, frameData.byteOffset, FRAME_SAMPLES)
    if (this._volume !== 1.0) {
      const floatSamples = new Float32Array(FRAME_SAMPLES)
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        floatSamples[i] = (samples[i] / 32768) * this._volume
      }
      samples = new Int16Array(FRAME_SAMPLES)
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        const val = Math.max(-1, Math.min(1, floatSamples[i]))
        samples[i] = Math.round(val * 32767)
      }
    }

    try {
      this._source.onData({
        samples,
        sampleRate: SAMPLE_RATE,
        bitsPerSample: BITS,
        channelCount: CHANNELS,
        numberOfFrames: FRAME_SAMPLES,
      })
      this._framesSent++
    } catch (err) {
      console.error('[Wire/Voice/Audio] Error sending frame:', err.message)
    }
  }

  stop() {
    this._stopped = true
    this._paused = true
    this._startTime = null
    this._pausedTime = 0
    this._pauseStart = null
    if (this._ffmpeg) { try { this._ffmpeg.kill() } catch {} ; this._ffmpeg = null }
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    this._buf = Buffer.alloc(0)
  }

  _drainAndFinish() {
    if (this._buf.length < FRAME_BYTES) {
      this._paused = true
      this.emit('finish')
      return
    }
    this._pump()
    setTimeout(() => this._drainAndFinish(), FRAME_DURATION)
  }

  setVolume(vol) {
    this._volume = vol
  }
}

class VideoPlayer extends EventEmitter {
  constructor(videoSource, filePath, loop = false) {
    super()
    this._source     = videoSource
    this._filePath   = sanitizeMediaInput(filePath)
    this._loop       = loop
    this._ffmpeg     = null
    this._timer      = null
    this._retryTimer = null
    this._buf        = Buffer.alloc(0)
    this._stopped    = false
    this._paused     = true
    this._framesSent = 0
    this._width      = VIDEO_WIDTH
    this._height     = VIDEO_HEIGHT
    this._startTime  = null
    this._pausedTime = 0 // Total time spent paused (for wall-clock position)
    this._pauseStart = null // When we paused (to track paused duration)
    this._isUrl      = isHttpInput(this._filePath)
    
    // Sync tracking
    this._lastFrameTime = null
    this._frameIntervals = []
    this._stutterCount = 0
    this._lastFrameSendTime = 0
    this._bufferFrameCount = 0
    this._hasStartedPlayback = false
    this._suppressNextClose = false
    
    // Config
    this._maxBufferFrames = LOW_LATENCY_MAX_VIDEO_BUFFER_FRAMES
    this._stutterThresholdMs = 50 // If frame takes >50ms, it's a stutter
    this._targetFPS = VIDEO_FPS
    this._frameIntervalMs = 1000 / this._targetFPS
    this._ffmpegInitialized = false // Track if ffmpeg has properly started
    this._retryCount = 0
    this._lastFfmpegError = ''
    this._debugLabel = 'Video'
    this._trimLogCooldownMs = 1200
    this._lastTrimLogAt = 0
    this._pendingTrimFrames = 0
    this._decodedFrames = 0
  }

  start() {
    this._stopped    = false
    this._paused     = true
    this._framesSent = 0
    this._startTime  = null
    this._hasStartedPlayback = false
    this._suppressNextClose = false
    this._ffmpegInitialized = false
    this._retryCount = 0
    this._lastFfmpegError = ''
    this._decodedFrames = 0
    const detectedFps = detectInputFpsSync(this._filePath, this._isUrl)
    this._targetFPS = detectedFps || VIDEO_FPS
    this._frameIntervalMs = 1000 / this._targetFPS
    this._stutterThresholdMs = Math.max(45, this._frameIntervalMs * 2.2)
    this._log(`Video target FPS set to ${this._targetFPS.toFixed(2)}${detectedFps ? ' (source-detected)' : ' (fallback)'}`)
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
    // Spawn lazily on first unpause to avoid startup kill/restart races.
    this._ffmpegInitialized = false
    if (this._ffmpeg) { try { this._ffmpeg.kill() } catch {} ; this._ffmpeg = null }
    this._buf = Buffer.alloc(0)
    this._bufferFrameCount = 0
  }

  _spawnFfmpeg() {
    if (this._stopped) return
    if (!this._filePath) {
      this.emit('error', new Error('Video input path/url is empty'))
      return
    }
    if (!this._isUrl && !fs.existsSync(this._filePath)) {
      this.emit('error', new Error(`Video file not found: ${this._filePath}`))
      return
    }
    
    // Reset initialization state for new ffmpeg instance
    this._ffmpegInitialized = false

    const inputArgs = this._isUrl
      ? ['-re', ...buildHttpInputArgs(this._filePath, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')]
      : ['-re', '-i', this._filePath]

    const args = [
      '-loglevel', 'warning',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-analyzeduration', '500000',
      '-probesize', '1000000',
      ...inputArgs,
      '-an',
      '-vf', 'scale=' + this._width + ':' + this._height + ':force_original_aspect_ratio=decrease:force_divisible_by=2,pad=' + this._width + ':' + this._height + ':(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-c:v', 'rawvideo',
      '-pix_fmt', 'yuv420p',
      '-f', 'rawvideo',
      'pipe:1'
    ]
    this._ffmpeg = spawn('ffmpeg', args)

    const frameSize = this._width * this._height * 3 / 2

    this._ffmpeg.stdout.on('data', (chunk) => {
      // Mark ffmpeg as initialized once we start receiving data
      if (!this._ffmpegInitialized && chunk.length >= frameSize) {
        this._ffmpegInitialized = true
        this._retryCount = 0
        this._log('Video decoder initialized')
      }
      if (chunk.length > 0) {
        this._decodedFrames += Math.floor(chunk.length / frameSize)
      }
      
      this._buf = Buffer.concat([this._buf, chunk])
      const maxBufferBytes = frameSize * MAX_VIDEO_BUFFER_FRAMES
      if (this._buf.length > maxBufferBytes) {
        const dropped = Math.floor((this._buf.length - maxBufferBytes) / frameSize)
        this._buf = this._buf.slice(this._buf.length - maxBufferBytes)
        if (dropped > 0) {
          this._pendingTrimFrames += dropped
          const now = Date.now()
          if ((now - this._lastTrimLogAt) >= this._trimLogCooldownMs) {
            this._log(`Trimmed oversized video buffer by ${this._pendingTrimFrames} frames`)
            this._pendingTrimFrames = 0
            this._lastTrimLogAt = now
          }
        }
      }
      this._bufferFrameCount = Math.floor(this._buf.length / frameSize)
    })

    this._ffmpeg.stderr.on('data', (d) => {
      const msg = d.toString().trim()
      if (msg) {
        this._lastFfmpegError = msg
        console.warn('[Wire/Voice/Video] ffmpeg:', msg)
      }
    })

    this._ffmpeg.on('close', (code) => {
      if (this._suppressNextClose) {
        this._suppressNextClose = false
        return
      }
      console.log(`[Wire/Voice/Video] ffmpeg closed (code=${code})`)
      const hadOutput = this._ffmpegInitialized || this._decodedFrames > 0 || this._buf.length >= frameSize
      const emptyClose = !hadOutput
      const shouldRetry = !this._stopped && this._isUrl && (code !== 0 || emptyClose) && this._retryCount < MAX_PLAYER_RETRY_ATTEMPTS
      if (shouldRetry) {
        this._retryCount++
        this._log(`Retrying video ffmpeg after close (attempt ${this._retryCount}/${MAX_PLAYER_RETRY_ATTEMPTS}, code=${code}, empty=${emptyClose})`)
        this._retryTimer = setTimeout(() => this._spawnFfmpeg(), FFMPEG_RETRY_BACKOFF_MS * this._retryCount)
        return
      }
      if (!this._stopped && (code !== 0 || emptyClose) && !hadOutput) {
        this.emit('error', new Error(`Video ffmpeg exited before initialization (code=${code}): ${this._lastFfmpegError || 'unknown error'}`))
        return
      }
      if (!this._stopped && this._loop) {
        this._buf = Buffer.alloc(0)
        this._spawnFfmpeg()
      } else {
        this._paused = true
        this.emit('finish')
      }
    })

    this._ffmpeg.on('error', (err) => {
      console.error('[Wire/Voice/Video] ffmpeg error:', err.message)
      this._lastFfmpegError = err.message
      if (this._retryCount < MAX_PLAYER_RETRY_ATTEMPTS) {
        this._retryCount++
        this._log(`Retrying ffmpeg (attempt ${this._retryCount}/${MAX_PLAYER_RETRY_ATTEMPTS})`)
        this._retryTimer = setTimeout(() => this._spawnFfmpeg(), FFMPEG_RETRY_BACKOFF_MS * this._retryCount)
      } else {
        this._retryCount = 0
        this.emit('error', err)
      }
    })
  }

  _log(...args) {
    console.log(`[Wire/Voice/${this._debugLabel}]`, ...args)
  }

  prime() {
    if (this._stopped) return
    if (!this._ffmpeg) this._spawnFfmpeg()
  }

  unpause(baseStartTime = null) {
    if (!this._paused) return
    const now = Number.isFinite(baseStartTime) ? baseStartTime : Date.now()

    // Ensure first playback starts from the beginning of the source.
    if (!this._hasStartedPlayback) {
      this._hasStartedPlayback = true
    }
    if (!this._ffmpeg) {
      this._buf = Buffer.alloc(0)
      this._bufferFrameCount = 0
      this._spawnFfmpeg()
    }

    this._paused = false
    
    // Track paused time for accurate wall-clock position
    if (this._pauseStart) {
      this._pausedTime += now - this._pauseStart
      this._pauseStart = null
    }
    
    // Initialize start time on first unpause
    if (!this._startTime) {
      this._startTime = now
    }
    
    this._lastFrameTime = now
    this._lastFrameSendTime = now
    this._bufferFrameCount = 0
    if (!this._timer && !this._stopped) {
      // Use setInterval at the target FPS for consistent timing
      this._timer = setInterval(() => this._pump(), Math.round(1000 / this._targetFPS))
    }
  }

  pause() {
    this._paused = true
    this._pauseStart = Date.now() // Track when we paused
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  _pump() {
    if (this._stopped || this._paused) return
    
    const frameSize = this._width * this._height * 3 / 2
    if (this._buf.length < frameSize) return

    const now = Date.now()
    
    // Track buffer size (how many frames are buffered)
    this._bufferFrameCount = Math.floor(this._buf.length / frameSize)
    if (this._bufferFrameCount > MAX_VIDEO_TARGET_BUFFER_FRAMES) {
      const staleFrames = this._bufferFrameCount - MAX_VIDEO_TARGET_BUFFER_FRAMES
      this._buf = this._buf.slice(staleFrames * frameSize)
      this._bufferFrameCount = Math.floor(this._buf.length / frameSize)
      this._pendingTrimFrames += staleFrames
      const nowTrim = Date.now()
      if ((nowTrim - this._lastTrimLogAt) >= this._trimLogCooldownMs && this._pendingTrimFrames > 0) {
        this._log(`Dropped ${this._pendingTrimFrames} stale video frames for low-latency catch-up`)
        this._pendingTrimFrames = 0
        this._lastTrimLogAt = nowTrim
      }
      if (this._buf.length < frameSize) return
    }
    
    // STUTTER DETECTION: Track time between frames
    if (this._lastFrameSendTime > 0) {
      const interval = now - this._lastFrameSendTime
      
      // Track frame intervals for jitter analysis
      this._frameIntervals.push(interval)
      if (this._frameIntervals.length > 30) {
        this._frameIntervals.shift()
      }
      
      // Detect stutter: if frame took much longer than expected
      if (interval > this._stutterThresholdMs) {
        this._stutterCount++
        // Emit stutter event for sync manager to handle
        this.emit('stutter', { interval, stutterCount: this._stutterCount })
      }
    }
    this._lastFrameSendTime = now

    // Frame-count pacing with bounded catch-up: if event loop lags, send up to 2
    // frames in one tick to reduce perceived jitter without huge bursts.
    const elapsedMs = this._startTime ? (Date.now() - this._startTime - this._pausedTime) : 0
    const expectedFrames = Math.max(1, Math.floor((elapsedMs / 1000) * this._targetFPS))
    const framesDue = Math.max(1, Math.min(2, expectedFrames - this._framesSent))

    for (let i = 0; i < framesDue; i++) {
      if (this._buf.length < frameSize) break
      this._framesSent++
      const frameData = Buffer.alloc(frameSize)
      this._buf.copy(frameData, 0, 0, frameSize)
      this._buf = this._buf.slice(frameSize)
      this._bufferFrameCount = Math.max(0, this._bufferFrameCount - 1)
      try {
        const videoFrame = {
          width: this._width,
          height: this._height,
          data: new Uint8ClampedArray(frameData),
        }
        this._source.onFrame(videoFrame)
      } catch (err) {
        console.error('[Wire/Voice/Video] Error sending frame:', err.message)
        break
      }
    }
  }
  
  // Get current video position - hybrid approach for RTC delay compensation
  // Initially uses wall clock (accurate at start), then switches to frame count (no drift)
  getPosition() {
    if (!this._startTime || this._paused) return 0
    
    // RTC has ~100ms inherent delay, use wall clock for first 3 seconds
    // then switch to frame count to prevent drift
    const elapsedMs = Date.now() - this._startTime - this._pausedTime
    
    if (elapsedMs < 3000) {
      // Initial phase: use wall clock (accurate at start)
      return elapsedMs + RTC_DELAY_MS
    } else {
      // Steady state: use frame count to prevent drift
      const frameDurationMs = 1000 / this._targetFPS
      return Math.floor(this._framesSent * frameDurationMs) + RTC_DELAY_MS
    }
  }
  
  // Get buffer status
  getBufferStatus() {
    return {
      bufferedFrames: this._bufferFrameCount,
      framesSent: this._framesSent,
      stutterCount: this._stutterCount,
      targetFps: this._targetFPS,
      avgFrameInterval: this._frameIntervals.length > 0 
        ? this._frameIntervals.reduce((a, b) => a + b, 0) / this._frameIntervals.length 
        : 0
    }
  }
  
  // Check if video is stuttering
  isStuttering() {
    return this._stutterCount > 3
  }
  
  // Reset stutter counter after sync
  resetStutterCount() {
    this._stutterCount = 0
    this._frameIntervals = []
  }
  
  // Method to force resync - aligns video frame count with audio position
  resync(audioPositionMs = null) {
    const now = Date.now()
    
    if (audioPositionMs !== null && audioPositionMs > 0) {
      // Calculate what frame count the video should be at to match audio position
      const targetFrameCount = Math.floor(audioPositionMs * this._targetFPS / 1000)
      this._framesSent = targetFrameCount
    } else {
      this._framesSent = 0
    }
    
    // Reset timing but keep the adjusted frame count
    this._startTime = now
    this._pausedTime = 0
    this._pauseStart = null
    this._lastFrameTime = now
    this._lastFrameSendTime = now
    this._stutterCount = 0
    this._frameIntervals = []
    this._bufferFrameCount = 0
  }

  stop() {
    this._stopped = true
    this._paused = true
    this._hasStartedPlayback = false
    this._suppressNextClose = false
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
    this._retryCount = 0
    if (this._ffmpeg) { try { this._ffmpeg.kill() } catch {} ; this._ffmpeg = null }
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    this._buf = Buffer.alloc(0)
  }
}

class StreamPlayer extends EventEmitter {
  constructor(audioSource, url, loop = false, effect = null) {
    super()
    this._source     = audioSource
    this._url        = sanitizeMediaInput(url)
    this._loop       = loop
    this._effect     = effect || { enabled: false, type: 'none', pitch: 0, reverb: 0, distortion: 0, echo: 0, tremolo: 0, robot: false, alien: false }
    this._ffmpeg     = null
    this._timer      = null
    this._retryTimer = null
    this._buf        = Buffer.alloc(0)
    this._stopped    = false
    this._paused     = true
    this._volume     = 1.0
    this._framesSent = 0
    this._startTime  = null
    this._pausedTime = 0 // Total time spent paused (for wall-clock position)
    this._pauseStart = null // When we paused (to track paused duration)
    this._hasStartedPlayback = false
    this._suppressNextClose = false
    this._retryCount = 0
    this._lastFfmpegError = ''
    this._debugLabel = 'Stream'
    this._trimLogCooldownMs = 1200
    this._lastTrimLogAt = 0
    this._pendingTrimFrames = 0
    this._decodedFrames = 0
  }

  start() {
    this._stopped    = false
    this._paused     = true
    this._framesSent = 0
    this._hasStartedPlayback = false
    this._suppressNextClose = false
    this._retryCount = 0
    this._lastFfmpegError = ''
    this._decodedFrames = 0
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
    // Spawn lazily on first unpause to avoid startup kill/restart races.
    if (this._ffmpeg) { try { this._ffmpeg.kill() } catch {} ; this._ffmpeg = null }
    this._buf = Buffer.alloc(0)
  }

  _spawnFfmpeg() {
    if (this._stopped) return

    if (!this._url) {
      this.emit('error', new Error('Stream URL is empty'))
      return
    }

    const isHttpUrl = isHttpInput(this._url)
    const isYouTube = this._url.includes('googlevideo.com')
    const userAgent = isYouTube 
      ? 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    
    const args = [
      '-loglevel', 'warning',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-analyzeduration', '0',
      '-probesize', '32k',
    ]

    if (isHttpUrl) {
      args.push('-re', ...buildHttpInputArgs(this._url, userAgent))
    } else {
      args.push('-re', '-i', this._url)
    }
    
    args.push(
      '-vn',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS)
    )
    
    const filter = buildAudioFilter(this._effect)
    if (filter) {
      args.push('-af', filter)
    }

    args.push('-f', 's16le', 'pipe:1')
    
    this._ffmpeg = spawn('ffmpeg', args)

    this._ffmpeg.stdout.on('data', (chunk) => {
      if (chunk.length > 0) {
        this._decodedFrames += Math.floor(chunk.length / FRAME_BYTES)
      }
      this._buf = Buffer.concat([this._buf, chunk])
      const maxBytes = FRAME_BYTES * MAX_STREAM_BUFFER_FRAMES
      if (this._buf.length > maxBytes) {
        const droppedFrames = Math.floor((this._buf.length - maxBytes) / FRAME_BYTES)
        this._buf = this._buf.slice(this._buf.length - maxBytes)
        if (droppedFrames > 0) {
          this._pendingTrimFrames += droppedFrames
          const now = Date.now()
          if ((now - this._lastTrimLogAt) >= this._trimLogCooldownMs && this._pendingTrimFrames > 0) {
            this._log(`Trimmed oversized audio buffer by ${this._pendingTrimFrames} frames`)
            this._pendingTrimFrames = 0
            this._lastTrimLogAt = now
          }
        }
      }
    })

    this._ffmpeg.stderr.on('data', (d) => {
      const msg = d.toString().trim()
      if (msg) {
        this._lastFfmpegError = msg
        console.warn('[Wire/Voice/Stream] ffmpeg:', msg)
      }
    })

    this._ffmpeg.on('close', (code) => {
      if (this._suppressNextClose) {
        this._suppressNextClose = false
        return
      }
      console.log(`[Wire/Voice/Stream] ffmpeg closed (code=${code})`)
      const hadOutput = this._decodedFrames > 0 || this._buf.length >= FRAME_BYTES
      const emptyClose = !hadOutput
      const shouldRetry = !this._stopped && isHttpUrl && (code !== 0 || emptyClose) && this._retryCount < MAX_PLAYER_RETRY_ATTEMPTS
      if (shouldRetry) {
        this._retryCount++
        this._log(`Retrying stream after close (attempt ${this._retryCount}/${MAX_PLAYER_RETRY_ATTEMPTS}, code=${code}, empty=${emptyClose})`)
        this._retryTimer = setTimeout(() => this._spawnFfmpeg(), FFMPEG_RETRY_BACKOFF_MS * this._retryCount)
        return
      }
      if (!this._stopped && (code !== 0 || emptyClose) && !hadOutput) {
        this.emit('error', new Error(`Stream ffmpeg exited without playable audio (code=${code}): ${this._lastFfmpegError || 'unknown error'}`))
        return
      }
      if (!this._stopped && this._loop) {
        this._buf = Buffer.alloc(0)
        this._spawnFfmpeg()
      } else {
        this._drainAndFinish()
      }
    })

    this._ffmpeg.on('error', (err) => {
      console.error('[Wire/Voice/Stream] ffmpeg error:', err.message)
      this._lastFfmpegError = err.message
      if (this._retryCount < MAX_PLAYER_RETRY_ATTEMPTS) {
        this._retryCount++
        this._log(`Retrying audio ffmpeg (attempt ${this._retryCount}/${MAX_PLAYER_RETRY_ATTEMPTS})`)
        this._retryTimer = setTimeout(() => this._spawnFfmpeg(), FFMPEG_RETRY_BACKOFF_MS * this._retryCount)
      } else {
        this._retryCount = 0
        this.emit('error', err)
      }
    })
  }

  _log(...args) {
    console.log(`[Wire/Voice/${this._debugLabel}]`, ...args)
  }

  // StreamPlayer unpause - aggressive pumping for streaming
  unpause(baseStartTime = null) {
    if (!this._paused) return
    const now = Number.isFinite(baseStartTime) ? baseStartTime : Date.now()

    // Ensure first playback starts from the beginning of the source.
    if (!this._hasStartedPlayback) {
      this._hasStartedPlayback = true
    }
    if (!this._ffmpeg) {
      this._buf = Buffer.alloc(0)
      this._spawnFfmpeg()
    }

    this._paused = false
    
    // Track paused time for accurate wall-clock position
    if (this._pauseStart) {
      this._pausedTime += now - this._pauseStart
      this._pauseStart = null
    }
    
    // Initialize start time on first unpause
    if (!this._startTime) {
      this._startTime = now
    }
    
    if (!this._timer && !this._stopped) {
      this._timer = setInterval(() => this._pump(), FRAME_DURATION)
    }
  }

  pause() {
    this._paused = true
    this._pauseStart = Date.now() // Track when we paused
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  // Get current audio position in milliseconds using wall-clock time (same as video)
  getPosition() {
    if (!this._startTime || this._paused) return 0
    // Wall-clock position: time since start minus time spent paused
    return Date.now() - this._startTime - this._pausedTime
  }

  _pump() {
    if (this._stopped || this._paused) return
    if (this._buf.length < FRAME_BYTES) return

    // Keep latency bounded by discarding old audio when producer outruns send cadence.
    const bufferedFrames = Math.floor(this._buf.length / FRAME_BYTES)
    if (bufferedFrames > MAX_STREAM_TARGET_BUFFER_FRAMES) {
      const staleFrames = bufferedFrames - MAX_STREAM_TARGET_BUFFER_FRAMES
      this._buf = this._buf.slice(staleFrames * FRAME_BYTES)
      this._pendingTrimFrames += staleFrames
      const now = Date.now()
      if ((now - this._lastTrimLogAt) >= this._trimLogCooldownMs && this._pendingTrimFrames > 0) {
        this._log(`Dropped ${this._pendingTrimFrames} stale audio frames for low-latency catch-up`)
        this._pendingTrimFrames = 0
        this._lastTrimLogAt = now
      }
      if (this._buf.length < FRAME_BYTES) return
    }

    const elapsedFrames = this._startTime
      ? Math.floor((Date.now() - this._startTime - this._pausedTime) / FRAME_DURATION)
      : this._framesSent + 1
    const framesDue = Math.max(1, Math.min(3, elapsedFrames - this._framesSent))

    for (let i = 0; i < framesDue; i++) {
      if (this._buf.length < FRAME_BYTES) break
      const frameData = Buffer.alloc(FRAME_BYTES)
      this._buf.copy(frameData, 0, 0, FRAME_BYTES)
      this._buf = this._buf.slice(FRAME_BYTES)

      let samples = new Int16Array(frameData.buffer, frameData.byteOffset, FRAME_SAMPLES)
      if (this._volume !== 1.0) {
        const floatSamples = new Float32Array(FRAME_SAMPLES)
        for (let j = 0; j < FRAME_SAMPLES; j++) {
          floatSamples[j] = (samples[j] / 32768) * this._volume
        }
        samples = new Int16Array(FRAME_SAMPLES)
        for (let j = 0; j < FRAME_SAMPLES; j++) {
          const val = Math.max(-1, Math.min(1, floatSamples[j]))
          samples[j] = Math.round(val * 32767)
        }
      }

      try {
        this._source.onData({
          samples,
          sampleRate: SAMPLE_RATE,
          bitsPerSample: BITS,
          channelCount: CHANNELS,
          numberOfFrames: FRAME_SAMPLES,
        })
        this._framesSent++
      } catch (err) {
        console.error('[Wire/Voice/Stream] Error sending frame:', err.message)
        break
      }
    }
  }

  stop() {
    this._stopped = true
    this._paused = true
    this._hasStartedPlayback = false
    this._suppressNextClose = false
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
    this._retryCount = 0
    if (this._ffmpeg) { try { this._ffmpeg.kill() } catch {} ; this._ffmpeg = null }
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    this._buf = Buffer.alloc(0)
  }

  resetPosition() {
    this._startTime = Date.now()
    this._framesSent = 0
  }

  _drainAndFinish() {
    if (this._buf.length < FRAME_BYTES) {
      this._paused = true
      this.emit('finish')
      return
    }
    this._pump()
    setTimeout(() => this._drainAndFinish(), FRAME_DURATION)
  }

  setVolume(vol) {
    this._volume = vol
  }
}

class PeerState {
  constructor(peerId, localId, polite) {
    this.peerId          = peerId
    this.polite          = polite
    this.pc              = null
    this.makingOffer     = false
    this.ignoreOffer     = false
    this.pendingCandidates = []
    this.remoteDescSet   = false
    this.needsNegotiation = false
    this.needsIceRestart  = false
    this._peerJoinEmitted = false
    this._joinResyncDone = false
  }
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

    const wrtc = loadWrtc()
    this._RTCPeerConnection     = wrtc.RTCPeerConnection
    this._RTCSessionDescription = wrtc.RTCSessionDescription
    this._RTCIceCandidate       = wrtc.RTCIceCandidate
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

    this._peers     = new Map()
    this._player    = null
    this._videoPlayer = null
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
      alien: false
    }
    this._throttledLogState = new Map()

    this._onParticipants  = this._onParticipants.bind(this)
    this._onUserJoined    = this._onUserJoined.bind(this)
    this._onUserLeft      = this._onUserLeft.bind(this)
    this._onOffer         = this._onOffer.bind(this)
    this._onAnswer        = this._onAnswer.bind(this)
    this._onIceCandidate  = this._onIceCandidate.bind(this)
    this._onForceReconnect = this._onForceReconnect.bind(this)
    this._onResyncRequest = this._onResyncRequest.bind(this)
    this._onSocketConnect = this._onSocketConnect.bind(this)
    this._onAnyDebug      = this._onAnyDebug.bind(this)
  }

  _log(...args) { if (this._debug) console.log('[Wire/Voice]', ...args) }

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

    this._socket.emit(eventName, {
      channelId: this._channelId,
      userId: this._botId,
      enabled,
    })
    this._lastVideoAnnouncementKey = key
    this._log(`Announced ${eventName} enabled=${enabled} (${reason})`)
    return true
  }

  _restoreVideoSignalingState(reason = 'restore') {
    if (!this._joined || !this._socket?.connected) return
    if (!this._videoTrack || !this._videoType) return
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
    this._log('Socket connected — rejoining channel and restoring media signaling')
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

  playFile(filePath, { loop = false, effect = null } = {}) {
    this.stopAudio()
    const resolved = path.resolve(filePath)
    
    const playerEffect = effect || this._voiceEffect
    this._player = new AudioPlayer(this._audioSource, resolved, loop, playerEffect)
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

  playUrl(url, { loop = false, effect = null } = {}) {
    this.stopAudio()
    const normalizedUrl = sanitizeMediaInput(url)
    if (!normalizedUrl || !isHttpInput(normalizedUrl)) {
      const err = new Error('playUrl expects a valid http(s) URL')
      this._log('Stream error:', err.message)
      this.emit('error', err)
      return Promise.reject(err)
    }
    
    const playerEffect = effect || this._voiceEffect
    this._player = new StreamPlayer(this._audioSource, normalizedUrl, loop, playerEffect)
    this._player.on('finish', () => { this._log('Stream finished:', normalizedUrl); this.emit('finish') })
    this._player.on('error',  (err) => { this._log('Stream error:', err.message); this.emit('error', err) })
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

  playVideo(filePath, { loop = false, type = 'screen', audioUrl = null } = {}) {
    this.stopVideo()
    this.stopAudio()
    
    const { RTCVideoSource } = loadWrtc().nonstandard
    this._videoSource = new RTCVideoSource({ isScreencast: type === 'screen' })
    this._videoTrack  = this._videoSource.createTrack()
    this._videoTrack.enabled = true
    this._videoTrack._senderTag = type
    this._videoStream = new this._MediaStream([this._videoTrack])
    this._videoType   = type

    const normalizedInput = sanitizeMediaInput(filePath)
    if (!normalizedInput) {
      const err = new Error('playVideo requires a valid path or URL')
      this._log('Video error:', err.message)
      this.emit('videoError', err)
      return Promise.reject(err)
    }

    const isUrl = isHttpInput(normalizedInput)
    const source = isUrl ? normalizedInput : path.resolve(normalizedInput)
    
    this._videoPlayer = new VideoPlayer(this._videoSource, source, loop)
    this._videoPlayer.on('finish', () => { 
      this._log('Video finished:', source)
      this.emit('videoFinish')
      this.stopVideo()
    })
    this._videoPlayer.on('error',  (err) => { this._log('Video error:', err.message); this.emit('videoError', err) })
    this._videoPlayer.start()
    this._videoPlayer.prime()
    this._log(`Playing video: ${source} (type: ${type})`)

    // Use a single media source path for video mode by default.
    // This keeps A/V naturally aligned without cross-source sync heuristics.
    const sameSourceAudio = source
    if (isHttpInput(sameSourceAudio)) {
      this._player = new StreamPlayer(this._audioSource, sameSourceAudio, loop, this._voiceEffect)
    } else {
      this._player = new AudioPlayer(this._audioSource, sameSourceAudio, loop, this._voiceEffect)
    }
    this._player.on('finish', () => { this._log('Video audio finished:', source) })
    this._player.on('error',  (err) => { this._log('Video audio error:', err.message); this.emit('error', err) })
    this._player.start()

    // Ensure both players start paused; both are unpaused together when peers are ready.
    this._player.pause()
    this._videoPlayer.pause()
    this._log(`Playing video audio: ${sameSourceAudio} (both paused for coordinated start)`)

    this._announceVideoState({ enabled: true, videoType: type, reason: 'playVideo-start' })

    this._addVideoTrackToPeers()

    const startPlayback = () => {
      if (!this._player || !this._videoPlayer) return
      const waitStart = Date.now()
      const waitForVideoFrame = () => {
        if (!this._player || !this._videoPlayer) return
        const status = this._videoPlayer.getBufferStatus()
        // Wait for at least one buffered frame to avoid black-start while audio runs.
        if (status.bufferedFrames >= 1 || Date.now() - waitStart > 2500) {
          const barrierTime = Date.now()
          this._videoPlayer.unpause(barrierTime)
          this._player.unpause(barrierTime)
          return
        }
        setTimeout(waitForVideoFrame, 30)
      }
      waitForVideoFrame()
    }

    if (this._hasConnectedPeer()) {
      this._log('Peers already connected — starting coordinated A/V playback')
      startPlayback()
    } else {
      const onPeerJoin = () => {
        this._log('Peer joined — starting coordinated A/V playback')
        startPlayback()
      }
      this.once('peerJoin', onPeerJoin)
      setTimeout(() => {
        this.off('peerJoin', onPeerJoin)
        if (this._player && this._videoPlayer && this._player._paused && this._videoPlayer._paused) {
          this._log('Fallback: starting coordinated A/V playback')
          startPlayback()
        }
      }, 3000)
    }

    return Promise.resolve()
  }

  _addVideoTrackToPeers() {
    if (!this._videoTrack || !this._videoStream) return
    
    for (const ps of this._peers.values()) {
      this._addVideoTrackToPeer(ps)
    }
  }

  _addVideoTrackToPeer(ps) {
    if (!this._videoTrack || !this._videoStream || !ps.pc) {
      this._log(`Cannot add video track to peer ${ps.peerId} - missing track, stream, or pc`)
      return false
    }
    
    // Check if connection is in a usable state
    const connState = ps.pc.connectionState
    if (connState !== 'connected') {
      this._log(`Peer ${ps.peerId} not connected (${connState}), will add video when connected`)
      return false
    }
    
    // Check if we already have this track added
    const existingSender = ps.pc.getSenders().find(s => s.track === this._videoTrack)
    if (existingSender) {
      this._log(`Video track already added to peer ${ps.peerId}`)
      return true
    }
    
    // Check for existing video sender we can replace
    const videoSender = ps.pc.getSenders().find(s => s.track?.kind === 'video')
    if (videoSender) {
      try {
        videoSender.replaceTrack(this._videoTrack)
        this._log(`Replaced video track for peer ${ps.peerId}`)
        this._negotiate(ps).catch(err => {
          this._log(`Failed to renegotiate replaced video track for ${ps.peerId}:`, err.message)
        })
        return true
      } catch (err) {
        this._log(`Error replacing video track for ${ps.peerId}:`, err.message)
      }
    }
    
    // Add new video track
    try {
      const sender = ps.pc.addTrack(this._videoTrack, this._videoStream)
      if (sender) {
        this._log(`Added video track to peer ${ps.peerId} - triggering renegotiation`)
        this._negotiate(ps).catch(err => {
          this._log(`Failed to renegotiate added video track for ${ps.peerId}:`, err.message)
        })
        return true
      }
    } catch (err) {
      this._log(`Error adding video track to ${ps.peerId}:`, err.message)
    }
    
    return false
  }

  _removeVideoTrackFromPeer(ps) {
    if (!ps?.pc) return false
    const pc = ps.pc
    const videoSender = pc.getSenders().find(s => s.track?.kind === 'video')
    if (!videoSender) return false

    try { videoSender.replaceTrack(null) } catch {}
    try { pc.removeTrack(videoSender) } catch {}

    this._log(`Removed video track sender for peer ${ps.peerId}`)
    this._negotiate(ps).catch(err => {
      this._log(`Failed to renegotiate after removing video for ${ps.peerId}:`, err.message)
    })
    return true
  }

  stopVideo() {
    if (this._syncInterval) {
      clearInterval(this._syncInterval)
      this._syncInterval = null
    }
    if (this._peerMonitorInterval) {
      clearInterval(this._peerMonitorInterval)
      this._peerMonitorInterval = null
    }
    const videoType = this._videoType
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

    if (this._socket?.connected && videoType) {
      this._announceVideoState({ enabled: false, videoType, reason: 'stopVideo' })
    }

    this._lastVideoAnnouncementKey = null
  }

  _hasConnectedPeer() {
    for (const ps of this._peers.values()) {
      if (ps.pc?.connectionState === 'connected') return true
    }
    return false
  }

  _onPeerConnected() {
    if (this._player && this._player._paused && !this._player._stopped) {
      this._log(`Peer connected — starting audio`)
      this._player.unpause()
    }

    if (this._videoPlayer && this._videoTrack) {
      this._addVideoTrackToPeers()
      if (this._videoPlayer._paused && !this._videoPlayer._stopped) {
        this._log(`Peer connected — starting video`)
        this._videoPlayer.unpause()
      }
    }
  }

  _resyncForPeerJoin(peerId) {
    if (!this._player || !this._videoPlayer) return
    if (this._player._stopped || this._videoPlayer._stopped) return

    // If playback is still paused globally, normal startSync flow will handle it.
    if (this._player._paused || this._videoPlayer._paused) return

    const audioPos = this._player.getPosition ? this._player.getPosition() : 0
    this._log(`Peer ${peerId} joined during active video — forcing sync barrier at ${Math.round(audioPos)}ms`)

    try { this._player.pause() } catch {}
    try { this._videoPlayer.pause() } catch {}
    if (this._videoPlayer.resync) {
      try { this._videoPlayer.resync(audioPos) } catch {}
    }

    const barrierTime = Date.now()
    setTimeout(() => {
      if (!this._player || !this._videoPlayer) return
      if (this._player._stopped || this._videoPlayer._stopped) return
      this._player.unpause(barrierTime)
      this._videoPlayer.unpause(barrierTime)
    }, 120)
  }

  stopAudio() {
    if (this._player) { this._player.stop(); this._player = null }
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
    const pc = new this._RTCPeerConnection({
      iceServers:   this._iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 10,
      iceTransportPolicy: 'all',
    })

    this._log(`Adding audio track to peer ${ps.peerId}`)
    const sender = pc.addTrack(this._audioTrack, this._audioStream)
    this._log(`Audio track added — sender exists: ${!!sender}`)

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
      if (pc.iceConnectionState === 'failed') {
        this._log(`ICE failed for ${ps.peerId} — attempting ICE restart`)
        this._restartIce(ps)
      }
    }

    pc.onconnectionstatechange = () => {
      this._log(`Peer ${ps.peerId} connection state: ${pc.connectionState}`)
      this._reportPeerState(ps.peerId, pc.connectionState)
      
      if (pc.connectionState === 'connected') {
        // Add video track to this peer if we have one
        if (this._videoTrack && this._videoStream) {
          this._log(`Peer ${ps.peerId} connected - adding video track`)
          this._addVideoTrackToPeer(ps)
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
      this._negotiate(ps).catch(err => {
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
    if (!ps?.pc) return
    if (ps.makingOffer) {
      ps.needsNegotiation = true
      ps.needsIceRestart = ps.needsIceRestart || !!iceRestart
      return
    }
    if (ps.pc.signalingState !== 'stable') {
      ps.needsNegotiation = true
      ps.needsIceRestart = ps.needsIceRestart || !!iceRestart
      return
    }

    const shouldIceRestart = !!iceRestart || !!ps.needsIceRestart
    try {
      ps.makingOffer = true
      ps.needsNegotiation = false
      ps.needsIceRestart = false
      await ps.pc.setLocalDescription(await ps.pc.createOffer({ iceRestart: shouldIceRestart }))
      this._socket.emit('voice:offer', {
        to:        ps.peerId,
        offer:     ps.pc.localDescription,
        channelId: this._channelId,
      })
      this._log(`Sent ${shouldIceRestart ? 'ICE-restart ' : ''}offer to ${ps.peerId}`)
    } catch (err) {
      this._log(`Negotiation failed for ${ps.peerId}:`, err.message)
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
    return this._negotiate(ps, { iceRestart: true })
  }

  _flushPendingNegotiation(ps) {
    if (!ps?.pc || ps.makingOffer || ps.pc.signalingState !== 'stable') return
    if (!ps.needsNegotiation && !ps.needsIceRestart) return
    const needsRestart = !!ps.needsIceRestart
    ps.needsNegotiation = false
    ps.needsIceRestart = false
    this._negotiate(ps, { iceRestart: needsRestart }).catch(err => {
      this._log(`Deferred negotiation failed for ${ps.peerId}:`, err.message)
    })
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

  _registerSocketListeners() {
    this._socket.on('voice:participants',  this._onParticipants)
    this._socket.on('voice:user-joined',   this._onUserJoined)
    this._socket.on('voice:user-left',     this._onUserLeft)
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
    }
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
  }

  _onUserLeft(data) {
    const userId = data?.userId || data?.id
    if (!userId || userId === this._botId) return
    this._log('User left voice:', userId)
    this._destroyPeerState(userId)
    this.emit('peerLeave', userId)
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

      await this._flushCandidates(ps)

      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)

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
      await this._flushCandidates(ps)
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
        this._onPeerConnected()
        return
      }
      this._pollForConnected(ps, attempts + 1)
    }, 250)
  }

  _onIceCandidate({ from, candidate, channelId }) {
    if (channelId !== this._channelId) return
    const ps = this._peers.get(from)
    if (!ps) return

    if (ps.remoteDescSet && ps.pc) {
      ps.pc.addIceCandidate(new this._RTCIceCandidate(candidate)).catch(err => {
        this._log(`Error adding ICE candidate:`, err.message)
      })
    } else {
      ps.pendingCandidates.push(candidate)
    }
  }
}
