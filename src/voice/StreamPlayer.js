import { EventEmitter } from '../EventEmitter.js'
import { spawn } from 'child_process'
import {
  isHttpInput,
  sanitizeMediaInput,
  buildHttpInputArgs,
  buildAudioFilter,
  isYouTubeDirectUrl,
  parseExtraHttpHeaders,
  DEFAULT_HTTP_USER_AGENT,
  YOUTUBE_DIRECT_HTTP_USER_AGENT,
} from './mediaUtils.js'
import { SAMPLE_RATE, CHANNELS, BITS, FRAME_DURATION, FRAME_SAMPLES, FRAME_BYTES, MAX_PLAYER_RETRY_ATTEMPTS, MAX_STREAM_BUFFER_FRAMES, MAX_STREAM_TARGET_BUFFER_FRAMES, FFMPEG_RETRY_BACKOFF_MS, MIN_URL_AUDIO_PLAYBACK_MS_BEFORE_FINISH, AUDIO_PREROLL_BUFFER_MS, RTC_DELAY_MS } from './constants.js'

function getFfmpegPath() {
  return process.env.WIRE_FFMPEG_PATH || process.env.FFMPEG_PATH || 'ffmpeg'
}

export class StreamPlayer extends EventEmitter {
  constructor(audioSource, url, loop = false, effect = null, startOffsetMs = 0) {
    super()
    this._source     = audioSource
    this._url        = sanitizeMediaInput(url)
    this._loop       = loop
    this._effect     = effect || { enabled: false, type: 'none', pitch: 0, reverb: 0, distortion: 0, echo: 0, tremolo: 0, robot: false, alien: false }
    this._startOffsetMs = Math.max(0, Number(startOffsetMs) || 0)
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
    this._isYouTubeDirect = false
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
    this._isYouTubeDirect = isYouTubeDirectUrl(this._url)
    const userAgent = this._isYouTubeDirect ? YOUTUBE_DIRECT_HTTP_USER_AGENT : DEFAULT_HTTP_USER_AGENT
    const extraHeaders = parseExtraHttpHeaders(process.env.WIRE_FFMPEG_EXTRA_HEADERS || '')
    
    const args = [
      '-loglevel', 'warning',
      '-analyzeduration', '0',
      '-probesize', '32',
    ]

    if (this._startOffsetMs > 0) {
      args.push('-ss', (this._startOffsetMs / 1000).toFixed(3))
    }

    if (isHttpUrl) {
      args.push(
        '-re',
        ...buildHttpInputArgs(this._url, userAgent, {
          isYouTubeDirect: this._isYouTubeDirect,
          extraHeaders,
        })
      )
    } else {
      args.push('-re', '-i', this._url)
    }
    
    args.push(
      '-fflags', 'nobuffer',
      '-avoid_negative_ts', 'make_zero',
      '-vn',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS)
    )
    
    const filter = buildAudioFilter(this._effect)
    const audioFilters = ['aresample=async=1:min_hard_comp=0.100:first_pts=0', 'asetpts=N/SR/TB']
    if (filter) {
      audioFilters.push(filter)
    }
    args.push('-af', audioFilters.join(','))

    args.push('-f', 's16le', 'pipe:1')
    
    this._ffmpeg = spawn(getFfmpegPath(), args)

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
      
      // Handle null code - process was killed externally or crashed unexpectedly
      // Only emit urlExpired for non-YouTube URLs that could be re-resolved
      // Direct URLs and YouTube direct URLs don't expire, so treat them as retryable
      if (code === null) {
        if (!this._stopped && isHttpUrl && !this._isYouTubeDirect) {
          this._log(`ffmpeg killed externally (code=${code}), emitting error for URL re-resolution`)
          this.emit('urlExpired', new Error('ffmpeg killed externally, URL may be expired'))
          return
        }
        // For direct URLs or YouTube direct, retry instead of giving up
        if (!this._stopped && isHttpUrl && this._retryCount < MAX_PLAYER_RETRY_ATTEMPTS) {
          this._retryCount++
          this._log(`ffmpeg killed externally (code=${code}), retrying (attempt ${this._retryCount}/${MAX_PLAYER_RETRY_ATTEMPTS})`)
          this._retryTimer = setTimeout(() => this._spawnFfmpeg(), FFMPEG_RETRY_BACKOFF_MS * this._retryCount)
          return
        }
        return
      }
      
      // For code 255 (SIGKILL), treat as crash - retry
      if (code === 255 && !this._stopped && isHttpUrl && this._retryCount < MAX_PLAYER_RETRY_ATTEMPTS) {
        this._retryCount++
        this._log(`ffmpeg crashed (code=${code}), retrying (attempt ${this._retryCount}/${MAX_PLAYER_RETRY_ATTEMPTS})`)
        this._retryTimer = setTimeout(() => this._spawnFfmpeg(), FFMPEG_RETRY_BACKOFF_MS * this._retryCount)
        return
      }
      
      const hadOutput = this._decodedFrames > 0 || this._buf.length >= FRAME_BYTES
      const emptyClose = !hadOutput
      const playedMs = this._framesSent * FRAME_DURATION
      const unexpectedEarlyUrlClose = isHttpUrl && !this._loop && hadOutput && code === 0 && playedMs < MIN_URL_AUDIO_PLAYBACK_MS_BEFORE_FINISH
      const shouldRetry = !this._stopped && isHttpUrl && (code !== 0 || emptyClose || unexpectedEarlyUrlClose) && this._retryCount < MAX_PLAYER_RETRY_ATTEMPTS
      if (shouldRetry) {
        this._retryCount++
        this._log(`Retrying stream after close (attempt ${this._retryCount}/${MAX_PLAYER_RETRY_ATTEMPTS}, code=${code}, empty=${emptyClose}, playedMs=${playedMs})`)
        this._retryTimer = setTimeout(() => this._spawnFfmpeg(), FFMPEG_RETRY_BACKOFF_MS * this._retryCount)
        return
      }
      if (!this._stopped && (code !== 0 || emptyClose || unexpectedEarlyUrlClose)) {
        const detail = !hadOutput
          ? `Stream ffmpeg exited without playable audio (code=${code})`
          : (unexpectedEarlyUrlClose
              ? `Stream ffmpeg closed too early for URL input (code=${code}, playedMs=${playedMs})`
              : `Stream ffmpeg interrupted mid-playback (code=${code})`)
        this.emit('error', new Error(`${detail}: ${this._lastFfmpegError || 'unknown error'}`))
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

  // Pre-buffer blank/silence frames to give time for RTC connection establishment
  // DISABLED: We wait for peer connection before starting playback, so RTC is already established
  // No need for blank frames - they cause audio to start late and have to catch up
  _preBufferBlankFrames() {
    // Don't add any blank frames - start with actual content immediately
    this._log(`Skipping blank frame preroll - starting with actual content immediately`)
  }

  // StreamPlayer unpause - aggressive pumping for streaming
  unpause(baseStartTime = null) {
    if (!this._paused) return
    const now = Number.isFinite(baseStartTime) ? baseStartTime : Date.now()

    // Ensure first playback starts from the beginning of the source.
    if (!this._hasStartedPlayback) {
      this._hasStartedPlayback = true
      // Pre-buffer blank frames for RTC establishment
      this._preBufferBlankFrames()
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

  // Get current audio position in milliseconds using wall-clock time
  // No preroll subtraction since we don't use blank frame buffering anymore
  getPosition() {
    if (!this._startTime || this._paused) return 0
    // Wall-clock position: time since start minus time spent paused
    const elapsedMs = Date.now() - this._startTime - this._pausedTime
    // No preroll to subtract - we start with actual content immediately
    return elapsedMs + RTC_DELAY_MS
  }

  _pump() {
    if (this._stopped || this._paused) return
    if (this._buf.length < FRAME_BYTES) return

    // Keep latency bounded without aggressive truncation that causes audible crackle.
    const bufferedFrames = Math.floor(this._buf.length / FRAME_BYTES)
    const targetBufferFrames = 40 // ~400ms smoothing under network jitter
    const highWaterFrames = 120
    if (bufferedFrames > highWaterFrames) {
      // Trim moderate chunks only when significantly overrun.
      const staleFrames = Math.min(20, bufferedFrames - targetBufferFrames)
      this._buf = this._buf.slice(staleFrames * FRAME_BYTES)
      this._pendingTrimFrames += Math.max(0, staleFrames)
      const now = Date.now()
      if ((now - this._lastTrimLogAt) >= this._trimLogCooldownMs && this._pendingTrimFrames > 0) {
        this._log(`Dropped ${this._pendingTrimFrames} stale audio frames for low-latency`)
        this._pendingTrimFrames = 0
        this._lastTrimLogAt = now
      }
      if (this._buf.length < FRAME_BYTES) return
    }

    // Adaptive cadence: usually 1 frame, catch-up 2 frames when backlog builds.
    const framesToSend = bufferedFrames > 80 ? 3 : (bufferedFrames > 50 ? 2 : 1)
    for (let i = 0; i < framesToSend; i++) {
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
