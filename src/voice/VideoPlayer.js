import { EventEmitter } from '../EventEmitter.js'
import { spawn } from 'child_process'
import fs from 'fs'
import {
  detectInputFpsSync,
  isHttpInput,
  sanitizeMediaInput,
  buildHttpInputArgs,
  isYouTubeDirectUrl,
  parseExtraHttpHeaders,
  DEFAULT_HTTP_USER_AGENT,
  YOUTUBE_DIRECT_HTTP_USER_AGENT,
} from './mediaUtils.js'
import { VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FPS, LOW_LATENCY_MAX_VIDEO_BUFFER_FRAMES, RTC_DELAY_MS, MAX_PLAYER_RETRY_ATTEMPTS, MAX_VIDEO_BUFFER_FRAMES, MAX_VIDEO_TARGET_BUFFER_FRAMES, FFMPEG_RETRY_BACKOFF_MS, MIN_URL_VIDEO_PLAYBACK_MS_BEFORE_FINISH, PREROLL_BUFFER_MS } from './constants.js'

function getFfmpegPath() {
  return process.env.WIRE_FFMPEG_PATH || process.env.FFMPEG_PATH || 'ffmpeg'
}

export class VideoPlayer extends EventEmitter {
  constructor(videoSource, filePath, loop = false, startOffsetMs = 0, profile = null) {
    super()
    this._source     = videoSource
    this._filePath   = sanitizeMediaInput(filePath)
    this._loop       = loop
    this._startOffsetMs = Math.max(0, Number(startOffsetMs) || 0)
    this._ffmpeg     = null
    this._timer      = null
    this._retryTimer = null
    this._buf        = Buffer.alloc(0)
    this._stopped    = false
    this._paused     = true
    this._framesSent = 0
    this._width      = Number.isFinite(profile?.width) && profile.width > 0 ? profile.width : VIDEO_WIDTH
    this._height     = Number.isFinite(profile?.height) && profile.height > 0 ? profile.height : VIDEO_HEIGHT
    this._startTime  = null
    this._pausedTime = 0 // Total time spent paused (for wall-clock position)
    this._pauseStart = null // When we paused (to track paused duration)
    this._isUrl      = isHttpInput(this._filePath)
    this._isYouTubeDirect = isYouTubeDirectUrl(this._filePath)
    
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
    this._targetFPS = Number.isFinite(profile?.fps) && profile.fps > 0 ? profile.fps : VIDEO_FPS
    this._frameIntervalMs = 1000 / this._targetFPS
    this._ffmpegInitialized = false // Track if ffmpeg has properly started
    this._retryCount = 0
    this._lastFfmpegError = ''
    this._debugLabel = 'Video'
    this._trimLogCooldownMs = 1200
    this._lastTrimLogAt = 0
    this._pendingTrimFrames = 0
    this._decodedFrames = 0
    
    this._firstFrameHeld = false
    this._firstFrameData = null
    this._prerollFrameCount = 3
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
    this._lastResyncTime = 0
    this._actualFps = null // Will be detected from ffmpeg output
    this._prerollFramesSent = 0 // Count of preroll (blank) frames sent
    
    this._firstFrameHeld = false
    this._firstFrameData = null
    
    // Try to detect FPS synchronously first (works better for files)
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
  
  // Update FPS based on actual ffmpeg output (more accurate for URLs)
  _updateActualFps(fps) {
    if (!fps || fps <= 0 || fps > 120) return
    
    // Only update if different from current
    if (this._actualFps && Math.abs(this._actualFps - fps) < 1) return
    
    this._actualFps = fps
    this._targetFPS = fps
    this._frameIntervalMs = 1000 / this._targetFPS
    this._stutterThresholdMs = Math.max(45, this._frameIntervalMs * 2.2)
    this._log(`Updated to actual FPS: ${fps.toFixed(2)}`)
    
    // Restart pump timer with new FPS if currently playing
    if (!this._paused && this._timer) {
      this._startPumpTimer()
    }
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

    const isYouTubeDirect = isYouTubeDirectUrl(this._filePath)
    const userAgent = isYouTubeDirect ? YOUTUBE_DIRECT_HTTP_USER_AGENT : DEFAULT_HTTP_USER_AGENT
    const extraHeaders = parseExtraHttpHeaders(process.env.WIRE_FFMPEG_EXTRA_HEADERS || '')

    const inputArgs = this._isUrl
      ? [
          '-re',
          ...(this._startOffsetMs > 0 ? ['-ss', (this._startOffsetMs / 1000).toFixed(3)] : []),
          ...buildHttpInputArgs(this._filePath, userAgent, {
            isYouTubeDirect,
            extraHeaders,
          })
        ]
      : [
          '-re',
          ...(this._startOffsetMs > 0 ? ['-ss', (this._startOffsetMs / 1000).toFixed(3)] : []),
          '-i', this._filePath
        ]

    const args = [
      '-loglevel', 'warning',
      '-analyzeduration', '0',
      '-probesize', '32',
      ...inputArgs,
      '-fflags', 'nobuffer',
      '-avoid_negative_ts', 'make_zero',
      '-an',
      '-vf', 'scale=' + this._width + ':' + this._height + ':force_original_aspect_ratio=decrease:force_divisible_by=2,pad=' + this._width + ':' + this._height + ':(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=start_mode=clone:start_duration=0.1',
      '-c:v', 'rawvideo',
      '-pix_fmt', 'yuv420p',
      '-f', 'rawvideo',
      'pipe:1'
    ]
    this._ffmpeg = spawn(getFfmpegPath(), args)

    const frameSize = this._width * this._height * 3 / 2

    this._ffmpeg.stdout.on('data', (chunk) => {
      // Mark ffmpeg as initialized once we start receiving data
      // Be more lenient - any substantial chunk indicates ffmpeg is working
      if (!this._ffmpegInitialized && chunk.length > 0) {
        this._ffmpegInitialized = true
        this._retryCount = 0
        this._log(`Video decoder initialized (first chunk: ${chunk.length} bytes)`)
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
        
        // Parse actual FPS from ffmpeg output (e.g., "30.00 fps" or "29.97 fps")
        const fpsMatch = msg.match(/(\d+\.?\d*)\s*fps/i)
        if (fpsMatch && !this._actualFps) {
          const parsedFps = parseFloat(fpsMatch[1])
          if (parsedFps > 0 && parsedFps <= 120) {
            this._updateActualFps(parsedFps)
          }
        }
        
        console.warn('[Wire/Voice/Video] ffmpeg:', msg)
      }
    })

    this._ffmpeg.on('close', (code) => {
      if (this._suppressNextClose) {
        this._suppressNextClose = false
        return
      }
      console.log(`[Wire/Voice/Video] ffmpeg closed (code=${code})`)
      
      // Handle null code - process was killed externally or crashed unexpectedly
      // Only emit urlExpired for non-YouTube URLs that could be re-resolved
      // Direct URLs and YouTube direct URLs don't expire, so treat them as retryable
      if (code === null) {
        if (!this._stopped && this._isUrl && !this._isYouTubeDirect) {
          this._log(`ffmpeg killed externally (code=${code}), emitting error for URL re-resolution`)
          this.emit('urlExpired', new Error('ffmpeg killed externally, URL may be expired'))
          return
        }
        // For direct URLs or YouTube direct, retry instead of giving up
        if (!this._stopped && this._isUrl && this._retryCount < MAX_PLAYER_RETRY_ATTEMPTS) {
          this._retryCount++
          this._log(`ffmpeg killed externally (code=${code}), retrying (attempt ${this._retryCount}/${MAX_PLAYER_RETRY_ATTEMPTS})`)
          this._retryTimer = setTimeout(() => this._spawnFfmpeg(), FFMPEG_RETRY_BACKOFF_MS * this._retryCount)
          return
        }
        return
      }
      
      // For code 255 (SIGKILL), treat as crash - but only retry if we're not stopped
      // and only if we haven't already retried too many times
      if (code === 255 && !this._stopped && this._isUrl && this._retryCount < MAX_PLAYER_RETRY_ATTEMPTS) {
        // Don't retry immediately if we just retried - add more delay
        this._retryCount++
        const retryDelay = Math.min(FFMPEG_RETRY_BACKOFF_MS * this._retryCount * 2, 5000)
        this._log(`ffmpeg crashed (code=${code}), retrying in ${retryDelay}ms (attempt ${this._retryCount}/${MAX_PLAYER_RETRY_ATTEMPTS})`)
        this._retryTimer = setTimeout(() => this._spawnFfmpeg(), retryDelay)
        return
      }
      
      const hadOutput = this._ffmpegInitialized || this._decodedFrames > 0 || this._buf.length >= frameSize
      const emptyClose = !hadOutput
      const playedMs = this._targetFPS > 0 ? Math.floor((this._framesSent * 1000) / this._targetFPS) : 0
      const unexpectedEarlyUrlClose = this._isUrl && !this._loop && hadOutput && code === 0 && playedMs < MIN_URL_VIDEO_PLAYBACK_MS_BEFORE_FINISH
      const shouldRetry = !this._stopped && this._isUrl && (code !== 0 || emptyClose || unexpectedEarlyUrlClose) && this._retryCount < MAX_PLAYER_RETRY_ATTEMPTS
      if (shouldRetry) {
        this._retryCount++
        this._log(`Retrying video ffmpeg after close (attempt ${this._retryCount}/${MAX_PLAYER_RETRY_ATTEMPTS}, code=${code}, empty=${emptyClose}, playedMs=${playedMs})`)
        this._retryTimer = setTimeout(() => this._spawnFfmpeg(), FFMPEG_RETRY_BACKOFF_MS * this._retryCount)
        return
      }
      if (!this._stopped && (code !== 0 || emptyClose || unexpectedEarlyUrlClose)) {
        const detail = !hadOutput
          ? `Video ffmpeg exited before initialization (code=${code})`
          : (unexpectedEarlyUrlClose
              ? `Video ffmpeg closed too early for URL input (code=${code}, playedMs=${playedMs})`
              : `Video ffmpeg interrupted mid-stream (code=${code})`)
        this.emit('error', new Error(`${detail}: ${this._lastFfmpegError || 'unknown error'}`))
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

  // Pre-buffer blank/black frames to give time for RTC connection establishment
  // DISABLED: We wait for peer connection before starting playback, so RTC is already established
  // No need for blank frames - they cause video to start late and have to catch up
  _preBufferBlankFrames() {
    // Don't add any blank frames - start with actual content immediately
    this._prerollFramesSent = 0
    this._log(`Skipping blank frame preroll - starting with actual content immediately`)
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
      // Pre-buffer blank frames for RTC establishment
      this._preBufferBlankFrames()
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
    
    // Use dynamic interval that can be updated based on actual FPS
    if (!this._timer && !this._stopped) {
      this._startPumpTimer()
    }
  }
  
  _startPumpTimer() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    // Use actual FPS if detected, otherwise target FPS
    const fps = this._actualFps || this._targetFPS
    const interval = Math.round(1000 / fps)
    this._timer = setInterval(() => this._pump(), interval)
    this._log(`Started pump timer at ${fps.toFixed(2)} FPS (${interval}ms interval)`)
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
    
    // Wait for ffmpeg to be initialized before sending frames
    if (!this._ffmpegInitialized) {
      return
    }
    
    // CRITICAL: Don't drop frames until we've sent the first frame
    // This ensures the first frame preroll can work properly
    if (this._framesSent === 0) {
      // Just ensure we have at least 1 frame, but don't drop any
      if (this._buf.length < frameSize) return
    } else {
      // Only drop stale frames after we've sent at least one frame
      const targetBufferFrames = 3
      if (this._bufferFrameCount > targetBufferFrames) {
        const staleFrames = this._bufferFrameCount - targetBufferFrames
        this._buf = this._buf.slice(staleFrames * frameSize)
        this._bufferFrameCount = Math.floor(this._buf.length / frameSize)
        this._pendingTrimFrames += staleFrames
        const nowTrim = Date.now()
        if ((nowTrim - this._lastTrimLogAt) >= this._trimLogCooldownMs && this._pendingTrimFrames > 0) {
          this._log(`Dropped ${this._pendingTrimFrames} stale video frames for low-latency`)
          this._pendingTrimFrames = 0
          this._lastTrimLogAt = nowTrim
        }
        if (this._buf.length < frameSize) return
      }
    }
    
    // STUTTER DETECTION: Track time between frames
    if (this._lastFrameSendTime > 0) {
      const interval = now - this._lastFrameSendTime
      
      this._frameIntervals.push(interval)
      if (this._frameIntervals.length > 30) {
        this._frameIntervals.shift()
      }
      
      if (interval > this._stutterThresholdMs) {
        this._stutterCount++
        this.emit('stutter', { interval, stutterCount: this._stutterCount })
      }
    }
    this._lastFrameSendTime = now

    // HYBRID PACING: Send 1-2 frames per tick based on buffer
    const framesToSend = this._bufferFrameCount >= 2 ? Math.min(2, this._bufferFrameCount) : 1
    
    for (let i = 0; i < framesToSend; i++) {
      if (this._buf.length < frameSize) break
      
      this._framesSent++
      
      let frameData
      if (!this._firstFrameHeld) {
        frameData = Buffer.alloc(frameSize)
        this._buf.copy(frameData, 0, 0, frameSize)
        this._firstFrameData = Buffer.from(frameData)
        this._firstFrameHeld = true
        this._log(`Holding first frame for preroll (${this._prerollFrameCount} copies)`)
        
        for (let j = 0; j < this._prerollFrameCount; j++) {
          this._sendVideoFrame(this._firstFrameData)
        }
        continue
      }
      
      frameData = Buffer.alloc(frameSize)
      this._buf.copy(frameData, 0, 0, frameSize)
      this._buf = this._buf.slice(frameSize)
      this._bufferFrameCount = Math.max(0, this._bufferFrameCount - 1)
      
      this._sendVideoFrame(frameData)
    }
  }

  _sendVideoFrame(frameData) {
    try {
      const videoFrame = {
        width: this._width,
        height: this._height,
        data: new Uint8ClampedArray(frameData),
      }
      this._source.onFrame(videoFrame)
    } catch (err) {
      console.error('[Wire/Voice/Video] Error sending frame:', err.message)
    }
  }
  
  // Get current video position - wall clock time since playback started
  // No preroll subtraction since we don't use blank frame buffering anymore
  getPosition() {
    if (!this._startTime || this._paused) return 0
    
    // Wall-clock position: time since start minus time spent paused
    const elapsedMs = Date.now() - this._startTime - this._pausedTime
    
    // No preroll to subtract - we start with actual content immediately
    return elapsedMs + RTC_DELAY_MS
  }
  
  // Get buffer status
  getBufferStatus() {
    return {
      bufferedFrames: this._bufferFrameCount,
      framesSent: this._framesSent,
      decodedFrames: this._decodedFrames,
      initialized: this._ffmpegInitialized,
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
  
  // Method to force resync - aligns video with audio position
  resync(audioPositionMs = null) {
    const now = Date.now()
    
    // Prevent excessive resyncs (debounce)
    if (now - this._lastResyncTime < 500) {
      return
    }
    this._lastResyncTime = now
    
    if (audioPositionMs !== null && audioPositionMs > 0) {
      // Simple sync: align frame count to audio position
      // No preroll calculations since we don't use blank frame buffering
      const targetFrameCount = Math.floor((audioPositionMs * this._targetFPS) / 1000)
      this._framesSent = targetFrameCount
      this._log(`Resynced to audio position ${audioPositionMs}ms (frame ${targetFrameCount})`)
    } else {
      this._framesSent = 0
      this._log('Resynced to start')
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
    
    // Clear buffer to avoid stale frames after resync
    this._buf = Buffer.alloc(0)
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
