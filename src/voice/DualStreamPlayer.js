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
import {
  SAMPLE_RATE,
  CHANNELS,
  BITS,
  FRAME_DURATION,
  FRAME_SAMPLES,
  FRAME_BYTES,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  VIDEO_FPS,
  MAX_STREAM_BUFFER_FRAMES,
  MAX_VIDEO_BUFFER_FRAMES,
  MAX_PLAYER_RETRY_ATTEMPTS,
  FFMPEG_RETRY_BACKOFF_MS,
  MIN_URL_VIDEO_PLAYBACK_MS_BEFORE_FINISH,
} from './constants.js'

function getFfmpegPath() {
  return process.env.WIRE_FFMPEG_PATH || process.env.FFMPEG_PATH || 'ffmpeg'
}

export class DualStreamPlayer extends EventEmitter {
  constructor(videoSource, audioSource, videoUrl, audioUrl, loop = false, effect = null, startOffsetMs = 0, profile = null) {
    super()
    this._videoSource = videoSource
    this._audioSource = audioSource
    this._videoUrl = sanitizeMediaInput(videoUrl)
    this._audioUrl = sanitizeMediaInput(audioUrl) || this._videoUrl
    this._loop = loop
    this._effect = effect || { enabled: false, type: 'none', pitch: 0, reverb: 0, distortion: 0, echo: 0, tremolo: 0, robot: false, alien: false }
    this._startOffsetMs = Math.max(0, Number(startOffsetMs) || 0)

    this._videoWidth = Number.isFinite(profile?.width) && profile.width > 0 ? profile.width : VIDEO_WIDTH
    this._videoHeight = Number.isFinite(profile?.height) && profile.height > 0 ? profile.height : VIDEO_HEIGHT
    this._targetFps = Number.isFinite(profile?.fps) && profile.fps > 0 ? profile.fps : VIDEO_FPS
    this._frameIntervalMs = 1000 / this._targetFps
    this._videoFrameBytes = this._videoWidth * this._videoHeight * 3 / 2

    this._ffmpeg = null
    this._retryTimer = null
    this._tickTimer = null
    this._stallTimer = null
    this._forceKillTimer = null
    this._hardKillTimer = null
    this._tickMs = 5
    this._spawnMode = 'realtime'
    this._pendingImmediateRespawnProc = null

    this._videoBuf = Buffer.alloc(0)
    this._audioBuf = Buffer.alloc(0)
    this._videoBufferFrameCount = 0
    this._audioBufferFrameCount = 0

    this._stopped = false
    this._paused = true
    this._videoPaused = true
    this._audioPaused = true
    this._ffmpegInitialized = false
    this._ffmpegClosed = false

    this._clockStarted = false
    this._clockStartMs = 0
    this._pauseStartedMs = 0
    this._pausedAccumMs = 0
    this._streamStartWallClock = 0

    this._videoFramesSent = 0
    this._audioFramesSent = 0
    this._lastAudioFrame = null
    this._lastAudioTailL = 0
    this._lastAudioTailR = 0
    this._audioUnderrunRepeats = 0
    this._audioUnderrunLogged = false
    this._silentAudioFrame = Buffer.alloc(FRAME_BYTES)
    this._firstFrameHeld = false
    this._firstFrameData = null
    this._prerollFrameCount = 3

    this._retryCount = 0
    this._lastFfmpegError = ''
    this._decodedVideoFrames = 0
    this._decodedAudioFrames = 0

    this._trimLogCooldownMs = 1200
    this._lastTrimLogAt = 0
    this._pendingTrimFrames = 0
    this._debugLabel = 'DualStream'
    this._spawnAttempt = 0
    this._startupFirstVideoBytesLogged = false
    this._startupFirstAudioBytesLogged = false
    this._startupFallbackReason = null
  }

  _log(...args) {
    console.log(`[Wire/Voice/${this._debugLabel}]`, ...args)
  }

  _setStartupFallbackReason(reason) {
    if (!reason || this._startupFallbackReason) return
    this._startupFallbackReason = reason
    this._log(`Startup transition: fallback reason=${reason}`)
  }

  start() {
    this._stopped = false
    this._paused = true
    this._videoPaused = true
    this._audioPaused = true
    this._ffmpegInitialized = false
    this._ffmpegClosed = false
    this._clockStarted = false
    this._clockStartMs = 0
    this._pauseStartedMs = 0
    this._pausedAccumMs = 0
    this._streamStartWallClock = 0

    this._videoFramesSent = 0
    this._audioFramesSent = 0
    this._lastAudioFrame = null
    this._lastAudioTailL = 0
    this._lastAudioTailR = 0
    this._audioUnderrunRepeats = 0
    this._audioUnderrunLogged = false
    this._firstFrameHeld = false
    this._firstFrameData = null

    this._retryCount = 0
    this._lastFfmpegError = ''
    this._decodedVideoFrames = 0
    this._decodedAudioFrames = 0
    this._pendingTrimFrames = 0
    this._spawnAttempt = 0
    this._startupFirstVideoBytesLogged = false
    this._startupFirstAudioBytesLogged = false
    this._startupFallbackReason = null

    this._videoBuf = Buffer.alloc(0)
    this._audioBuf = Buffer.alloc(0)
    this._videoBufferFrameCount = 0
    this._audioBufferFrameCount = 0

    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null }
    if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null }
    if (this._forceKillTimer) { clearTimeout(this._forceKillTimer); this._forceKillTimer = null }
    if (this._hardKillTimer) { clearTimeout(this._hardKillTimer); this._hardKillTimer = null }
    this._pendingImmediateRespawnProc = null
    if (this._ffmpeg) { try { this._ffmpeg.kill() } catch {} ; this._ffmpeg = null }
  }

  prime() {
    if (this._stopped) return
    if (!this._ffmpeg) this._spawnFfmpeg()
  }

  unpause(baseStartTime = null) {
    if (this._stopped) return
    const now = Number.isFinite(baseStartTime) ? baseStartTime : Date.now()

    if (!this._ffmpeg) this._spawnFfmpeg()

    if (this._paused && this._pauseStartedMs > 0) {
      this._pausedAccumMs += (now - this._pauseStartedMs)
      this._pauseStartedMs = 0
    }
    this._paused = false
    this._videoPaused = false
    this._audioPaused = false

    if (!this._clockStarted) {
      this._clockStarted = true
      this._clockStartMs = now
      this._streamStartWallClock = now
    }

    if (!this._tickTimer) {
      this._tickTimer = setInterval(() => this._tick(), this._tickMs)
    }

    this._log('Unpaused dual stream scheduler')
  }

  pause() {
    if (this._paused) return
    this._paused = true
    this._videoPaused = true
    this._audioPaused = true
    this._pauseStartedMs = Date.now()
    if (this._tickTimer) {
      clearInterval(this._tickTimer)
      this._tickTimer = null
    }
  }

  stop() {
    this._stopped = true
    this._paused = true
    this._videoPaused = true
    this._audioPaused = true
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null }
    if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null }
    if (this._forceKillTimer) { clearTimeout(this._forceKillTimer); this._forceKillTimer = null }
    if (this._hardKillTimer) { clearTimeout(this._hardKillTimer); this._hardKillTimer = null }
    this._pendingImmediateRespawnProc = null
    if (this._ffmpeg) { try { this._ffmpeg.kill() } catch {} ; this._ffmpeg = null }

    this._videoBuf = Buffer.alloc(0)
    this._audioBuf = Buffer.alloc(0)
    this._videoBufferFrameCount = 0
    this._audioBufferFrameCount = 0
    this._lastAudioFrame = null
    this._lastAudioTailL = 0
    this._lastAudioTailR = 0
    this._audioUnderrunRepeats = 0
    this._audioUnderrunLogged = false
    this._ffmpegClosed = true
  }

  _killFfmpegForImmediateRespawn(proc) {
    if (!proc || this._stopped) return
    if (this._forceKillTimer) { clearTimeout(this._forceKillTimer); this._forceKillTimer = null }
    if (this._hardKillTimer) { clearTimeout(this._hardKillTimer); this._hardKillTimer = null }
    try { proc.kill('SIGTERM') } catch {}
    this._forceKillTimer = setTimeout(() => {
      if (this._stopped || this._ffmpeg !== proc) return
      this._log('Fallback respawn: ffmpeg did not exit after SIGTERM, escalating to SIGKILL')
      try { proc.kill('SIGKILL') } catch {}
    }, 700)
    this._hardKillTimer = setTimeout(() => {
      if (this._stopped || this._ffmpeg !== proc) return
      this._log('Fallback respawn: forcing immediate spawn after kill timeout')
      this._pendingImmediateRespawnProc = null
      this._ffmpeg = null
      this._spawnFfmpeg()
    }, 1700)
  }

  _spawnFfmpeg() {
    if (this._stopped) return
    if (!this._videoUrl) {
      this.emit('error', new Error('Video URL is empty'))
      return
    }

    const isVideoUrl = isHttpInput(this._videoUrl)
    const isAudioUrl = isHttpInput(this._audioUrl)
    const isVideoYouTubeDirect = isYouTubeDirectUrl(this._videoUrl)
    const isAudioYouTubeDirect = isYouTubeDirectUrl(this._audioUrl)
    const anyHttpInput = isVideoUrl || isAudioUrl
    const analyzeDuration = '1000000'
    const probeSize = '1000000'
    const extraHeaders = parseExtraHttpHeaders(process.env.WIRE_FFMPEG_EXTRA_HEADERS || '')
    const seekArg = this._startOffsetMs > 0 ? ['-ss', (this._startOffsetMs / 1000).toFixed(3)] : []

    const args = [
      '-loglevel', 'warning',
      '-analyzeduration', analyzeDuration,
      '-probesize', probeSize,
    ]
    // Wallclock input timestamps on HTTP YouTube URLs can explode A/V deltas
    // and trigger massive frame duplication. Keep source timestamps for HTTP.
    if (!anyHttpInput) {
      args.push('-use_wallclock_as_timestamps', '1')
    }

    const useRealtimeInput = this._spawnMode === 'realtime'
    const useRealtimeVideoInput = useRealtimeInput && !isVideoUrl
    const useRealtimeAudioInput = useRealtimeInput && !isAudioUrl

    if (isVideoUrl) {
      const videoUserAgent = isVideoYouTubeDirect ? YOUTUBE_DIRECT_HTTP_USER_AGENT : DEFAULT_HTTP_USER_AGENT
      args.push(
        ...(useRealtimeVideoInput ? ['-re'] : []),
        ...seekArg,
        ...buildHttpInputArgs(this._videoUrl, videoUserAgent, {
          isYouTubeDirect: isVideoYouTubeDirect,
          extraHeaders,
        })
      )
    } else {
      args.push(...(useRealtimeVideoInput ? ['-re'] : []), ...seekArg, '-i', this._videoUrl)
    }

    if (this._audioUrl && this._audioUrl !== this._videoUrl) {
      if (isAudioUrl) {
        const audioUserAgent = isAudioYouTubeDirect ? YOUTUBE_DIRECT_HTTP_USER_AGENT : DEFAULT_HTTP_USER_AGENT
        args.push(
          ...(useRealtimeAudioInput ? ['-re'] : []),
          ...seekArg,
          ...buildHttpInputArgs(this._audioUrl, audioUserAgent, {
            isYouTubeDirect: isAudioYouTubeDirect,
            extraHeaders,
          })
        )
      } else {
        args.push(...(useRealtimeAudioInput ? ['-re'] : []), ...seekArg, '-i', this._audioUrl)
      }
    }

    args.push('-fflags', '+genpts+discardcorrupt', '-avoid_negative_ts', 'make_zero')

    const audioFilters = ['aresample=async=1:min_hard_comp=0.050:first_pts=0', 'asetpts=N/SR/TB']
    const effectFilter = buildAudioFilter(this._effect)
    if (effectFilter) audioFilters.push(effectFilter)

    const videoFilter = this._spawnMode === 'realtime'
      ? `scale=${this._videoWidth}:${this._videoHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2:in_range=tv:out_range=pc,format=yuv420p`
      : `scale=${this._videoWidth}:${this._videoHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`
    if (this._audioUrl && this._audioUrl !== this._videoUrl) {
      args.push(
        '-map', '0:v:0', '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', '-vf', videoFilter, '-r', String(this._targetFps), '-f', 'rawvideo', 'pipe:3',
        '-map', '1:a:0', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-af', audioFilters.join(','), '-f', 's16le', 'pipe:4',
      )
    } else {
      args.push(
        '-map', '0:v:0', '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', '-vf', videoFilter, '-r', String(this._targetFps), '-f', 'rawvideo', 'pipe:3',
        '-map', '0:a:0', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-af', audioFilters.join(','), '-f', 's16le', 'pipe:4',
      )
    }

    const spawnAttempt = ++this._spawnAttempt
    this._log(`Startup transition: spawn attempt=${spawnAttempt} mode=${this._spawnMode}`)
    this._log(`Spawning dual ffmpeg (${this._spawnMode}): ${args.join(' ')}`)
    this._ffmpegClosed = false
    this._ffmpegInitialized = false
    this._decodedVideoFrames = 0
    this._decodedAudioFrames = 0
    this._ffmpeg = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
    const ffmpegProc = this._ffmpeg
    if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null }
    this._stallTimer = setTimeout(() => {
      if (this._stopped || this._ffmpeg !== ffmpegProc) return
      if (this._decodedVideoFrames > 0 || this._decodedAudioFrames > 0) return
      if (this._spawnMode === 'realtime') {
        this._setStartupFallbackReason('decoder-stall-no-output')
        this._log('Dual ffmpeg stalled with no output, switching to fallback spawn mode')
        this._spawnMode = 'fallback'
        if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
        this._pendingImmediateRespawnProc = ffmpegProc
        this._killFfmpegForImmediateRespawn(ffmpegProc)
      }
    }, 4500)

    ffmpegProc.stdio[3].on('data', (chunk) => {
      if (this._ffmpeg !== ffmpegProc) return
      if (!chunk || chunk.length === 0) return
      if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null }
      if (!this._startupFirstVideoBytesLogged) {
        this._startupFirstVideoBytesLogged = true
        this._log(`Startup transition: first decoded video bytes=${chunk.length}`)
      }
      this._videoBuf = Buffer.concat([this._videoBuf, chunk])
      this._decodedVideoFrames += Math.floor(chunk.length / this._videoFrameBytes)
      if (!this._ffmpegInitialized && this._videoBuf.length >= this._videoFrameBytes) {
        this._ffmpegInitialized = true
        this._retryCount = 0
        this._log('DualStream decoder initialized - video and audio flowing')
      }
      const maxVideoBytes = this._videoFrameBytes * MAX_VIDEO_BUFFER_FRAMES
      if (this._videoBuf.length > maxVideoBytes) {
        const dropped = Math.floor((this._videoBuf.length - maxVideoBytes) / this._videoFrameBytes)
        this._videoBuf = this._videoBuf.slice(this._videoBuf.length - maxVideoBytes)
        if (dropped > 0) this._pendingTrimFrames += dropped
      }
      this._videoBufferFrameCount = Math.floor(this._videoBuf.length / this._videoFrameBytes)
    })

    ffmpegProc.stdio[4].on('data', (chunk) => {
      if (this._ffmpeg !== ffmpegProc) return
      if (!chunk || chunk.length === 0) return
      if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null }
      if (!this._startupFirstAudioBytesLogged) {
        this._startupFirstAudioBytesLogged = true
        this._log(`Startup transition: first decoded audio bytes=${chunk.length}`)
      }
      this._audioBuf = Buffer.concat([this._audioBuf, chunk])
      this._decodedAudioFrames += Math.floor(chunk.length / FRAME_BYTES)
      const maxAudioBytes = FRAME_BYTES * MAX_STREAM_BUFFER_FRAMES
      if (this._audioBuf.length > maxAudioBytes) {
        const dropped = Math.floor((this._audioBuf.length - maxAudioBytes) / FRAME_BYTES)
        this._audioBuf = this._audioBuf.slice(this._audioBuf.length - maxAudioBytes)
        if (dropped > 0) this._pendingTrimFrames += dropped
      }
      this._audioBufferFrameCount = Math.floor(this._audioBuf.length / FRAME_BYTES)
    })

    ffmpegProc.stderr.on('data', (d) => {
      if (this._ffmpeg !== ffmpegProc) return
      const msg = d.toString().trim()
      if (msg) {
        this._lastFfmpegError = msg
        console.warn('[Wire/Voice/DualStream] ffmpeg:', msg)
      }
    })

    ffmpegProc.on('close', (code) => {
      if (this._ffmpeg !== ffmpegProc) return
      this._ffmpeg = null
      this._ffmpegClosed = true
      if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null }
      if (this._forceKillTimer) { clearTimeout(this._forceKillTimer); this._forceKillTimer = null }
      if (this._hardKillTimer) { clearTimeout(this._hardKillTimer); this._hardKillTimer = null }
      if (this._pendingImmediateRespawnProc === ffmpegProc) {
        this._pendingImmediateRespawnProc = null
        if (!this._stopped) {
          this._log('Respawning dual ffmpeg immediately in fallback mode')
          this._spawnFfmpeg()
        }
        return
      }
      if (this._stopped) return

      // Handle null code - process was killed externally or crashed unexpectedly
      // Only emit urlExpired for non-YouTube URLs that could be re-resolved
      // Direct URLs and YouTube direct URLs don't expire, so treat them as retryable
      if (code === null) {
        const anyHttpInput = isHttpInput(this._videoUrl) || isHttpInput(this._audioUrl)
        const anyYouTubeDirect = isYouTubeDirectUrl(this._videoUrl) || isYouTubeDirectUrl(this._audioUrl)
        if (anyHttpInput && !anyYouTubeDirect) {
          this._log(`ffmpeg killed externally (code=${code}), emitting error for URL re-resolution`)
          this.emit('urlExpired', new Error('ffmpeg killed externally, URL may be expired'))
          return
        }
        // For direct URLs or YouTube direct, retry instead of giving up
        if (anyHttpInput && this._retryCount < MAX_PLAYER_RETRY_ATTEMPTS) {
          this._retryCount++
          this._log(`ffmpeg killed externally (code=${code}), retrying (attempt ${this._retryCount}/${MAX_PLAYER_RETRY_ATTEMPTS})`)
          this._retryTimer = setTimeout(() => this._spawnFfmpeg(), FFMPEG_RETRY_BACKOFF_MS * this._retryCount)
          return
        }
        return
      }

      const hadOutput = this._ffmpegInitialized || this._decodedVideoFrames > 0 || this._decodedAudioFrames > 0
      const playbackMs = this._streamStartWallClock > 0 ? (Date.now() - this._streamStartWallClock) : 0
      const endedTooEarly = playbackMs > 0 && playbackMs < MIN_URL_VIDEO_PLAYBACK_MS_BEFORE_FINISH
      const buffersHaveData = this._videoBuf.length >= this._videoFrameBytes || this._audioBuf.length >= FRAME_BYTES

      if (this._loop && code === 0 && !endedTooEarly) {
        this._videoBuf = Buffer.alloc(0)
        this._audioBuf = Buffer.alloc(0)
        this._videoBufferFrameCount = 0
        this._audioBufferFrameCount = 0
        this._spawnFfmpeg()
        return
      }

      const shouldRetry = !this._stopped && (code !== 0 || !hadOutput || endedTooEarly) && this._retryCount < MAX_PLAYER_RETRY_ATTEMPTS
      if (shouldRetry) {
        this._retryCount++
        if (!hadOutput && this._spawnMode === 'realtime') {
          this._setStartupFallbackReason(`retry-no-output-exit-${code}`)
          this._spawnMode = 'fallback'
        }
        this._log(`Retrying dual ffmpeg (attempt ${this._retryCount}/${MAX_PLAYER_RETRY_ATTEMPTS})`)
        this._retryTimer = setTimeout(() => this._spawnFfmpeg(), FFMPEG_RETRY_BACKOFF_MS * this._retryCount)
        return
      }

      if (!buffersHaveData) {
        this.emit('finish')
      }
    })

    ffmpegProc.on('error', (err) => {
      if (this._ffmpeg !== ffmpegProc) return
      this._lastFfmpegError = err.message
      if (this._forceKillTimer) { clearTimeout(this._forceKillTimer); this._forceKillTimer = null }
      if (this._hardKillTimer) { clearTimeout(this._hardKillTimer); this._hardKillTimer = null }
      if (this._pendingImmediateRespawnProc === ffmpegProc) {
        this._pendingImmediateRespawnProc = null
        if (!this._stopped) {
          this._log('Respawning dual ffmpeg immediately after fallback kill error')
          this._ffmpeg = null
          this._spawnFfmpeg()
        }
        return
      }
      if (this._retryCount < MAX_PLAYER_RETRY_ATTEMPTS) {
        this._retryCount++
        this._retryTimer = setTimeout(() => this._spawnFfmpeg(), FFMPEG_RETRY_BACKOFF_MS * this._retryCount)
      } else {
        this.emit('error', err)
      }
    })
  }

  _tick() {
    if (this._stopped || this._paused || !this._clockStarted) return

    const now = Date.now()
    const elapsedMs = Math.max(0, now - this._clockStartMs - this._pausedAccumMs)

    this._videoBufferFrameCount = Math.floor(this._videoBuf.length / this._videoFrameBytes)
    this._audioBufferFrameCount = Math.floor(this._audioBuf.length / FRAME_BYTES)
    const readyVideoFrames = this._videoBufferFrameCount
    const readyAudioFrames = this._audioBufferFrameCount

    if (!this._firstFrameHeld) {
      if (!this._ffmpegInitialized || readyVideoFrames < 1 || readyAudioFrames < 10) {
        if (this._ffmpegClosed && readyVideoFrames === 0 && readyAudioFrames === 0) this.emit('finish')
        return
      }
      this._firstFrameData = Buffer.from(this._videoBuf.slice(0, this._videoFrameBytes))
      this._firstFrameHeld = true
      this._log(`Holding first frame for preroll (${this._prerollFrameCount} copies)`)
      for (let i = 0; i < this._prerollFrameCount; i++) this._sendVideoFrame(this._firstFrameData)
    }

    const targetAudioFrames = Math.floor(elapsedMs / FRAME_DURATION)
    const targetVideoFrames = Math.floor((elapsedMs / 1000) * this._targetFps)

    let audioNeed = Math.max(0, targetAudioFrames - this._audioFramesSent)
    let videoNeed = Math.max(0, targetVideoFrames - this._videoFramesSent)

    // Keep catch-up bounded and adaptive: with shallow audio buffer, emit smaller bursts.
    const maxAudioBurst = readyAudioFrames >= 18 ? 8 : (readyAudioFrames >= 8 ? 5 : (readyAudioFrames >= 2 ? 2 : 1))
    const maxVideoBurst = readyVideoFrames >= 2 ? 2 : 1
    audioNeed = Math.min(audioNeed, maxAudioBurst)
    videoNeed = Math.min(videoNeed, maxVideoBurst)

    // Pull A/V clocks toward each other when they drift.
    const audioMs = this._audioFramesSent * FRAME_DURATION
    const videoMs = (this._videoFramesSent / this._targetFps) * 1000
    const driftMs = videoMs - audioMs
    if (driftMs > 140) {
      // Video is ahead; let audio catch up instead of starving it.
      videoNeed = 0
      audioNeed = Math.max(audioNeed, 1)
    } else if (driftMs < -140) {
      // Audio is ahead; bias toward video catch-up and avoid running audio too fast.
      videoNeed = Math.min(3, videoNeed + 1)
      audioNeed = Math.min(audioNeed, 1)
    }

    // If audio is starved, avoid letting video run too far ahead in the same tick.
    if (readyAudioFrames === 0 && this._audioUnderrunRepeats > 0) {
      videoNeed = Math.min(videoNeed, 1)
    }

    for (let i = 0; i < videoNeed; i++) {
      if (this._videoBuf.length < this._videoFrameBytes) break
      const frame = Buffer.from(this._videoBuf.slice(0, this._videoFrameBytes))
      this._videoBuf = this._videoBuf.slice(this._videoFrameBytes)
      this._sendVideoFrame(frame)
    }

    for (let i = 0; i < audioNeed; i++) {
      if (this._audioBuf.length >= FRAME_BYTES) {
        const frame = Buffer.from(this._audioBuf.slice(0, FRAME_BYTES))
        this._audioBuf = this._audioBuf.slice(FRAME_BYTES)
        this._sendAudioFrame(frame, false)
        if (this._audioUnderrunLogged) {
          this._log('Audio underrun recovered')
          this._audioUnderrunLogged = false
        }
        this._audioUnderrunRepeats = 0
      } else {
        const fallback = this._buildUnderrunAudioFrame()
        this._sendAudioFrame(fallback, true)
        this._audioUnderrunRepeats++
        if (!this._audioUnderrunLogged && this._audioUnderrunRepeats >= 2) {
          this._log('Audio underrun detected - applying soft fallback pacing')
          this._audioUnderrunLogged = true
        }
      }
    }

    this._videoBufferFrameCount = Math.floor(this._videoBuf.length / this._videoFrameBytes)
    this._audioBufferFrameCount = Math.floor(this._audioBuf.length / FRAME_BYTES)

    if (this._pendingTrimFrames > 0) {
      const nowMs = Date.now()
      if ((nowMs - this._lastTrimLogAt) >= this._trimLogCooldownMs) {
        this._log(`Trimmed ${this._pendingTrimFrames} stale frames for low-latency`)
        this._pendingTrimFrames = 0
        this._lastTrimLogAt = nowMs
      }
    }

    if (this._ffmpegClosed && this._videoBufferFrameCount === 0 && this._audioBufferFrameCount === 0) {
      this.emit('finish')
    }
  }

  _sendVideoFrame(frameData) {
    try {
      const videoFrame = {
        width: this._videoWidth,
        height: this._videoHeight,
        data: new Uint8ClampedArray(frameData),
      }
      this._videoSource.onFrame(videoFrame)
      this._videoFramesSent++
    } catch (err) {
      console.error('[Wire/Voice/DualStream] Error sending video frame:', err.message)
    }
  }

  _scaleAudioFrame(frameData, gain) {
    const out = Buffer.allocUnsafe(FRAME_BYTES)
    for (let i = 0; i < FRAME_BYTES; i += 2) {
      const sample = frameData.readInt16LE(i)
      let scaled = Math.round(sample * gain)
      if (scaled > 32767) scaled = 32767
      else if (scaled < -32768) scaled = -32768
      out.writeInt16LE(scaled, i)
    }
    return out
  }

  _makeRampToSilenceFrame() {
    const out = Buffer.from(this._silentAudioFrame)
    const rampSamples = Math.min(96, FRAME_SAMPLES)
    for (let i = 0; i < rampSamples; i++) {
      const t = 1 - (i / rampSamples)
      const left = Math.round(this._lastAudioTailL * t)
      const right = Math.round(this._lastAudioTailR * t)
      const base = i * CHANNELS * 2
      out.writeInt16LE(left, base)
      out.writeInt16LE(right, base + 2)
    }
    return out
  }

  _buildUnderrunAudioFrame() {
    if (!this._lastAudioFrame) {
      return this._makeRampToSilenceFrame()
    }

    // Avoid repeating the exact same PCM indefinitely; decay toward silence.
    if (this._audioUnderrunRepeats <= 0) return this._lastAudioFrame
    if (this._audioUnderrunRepeats === 1) return this._scaleAudioFrame(this._lastAudioFrame, 0.72)
    if (this._audioUnderrunRepeats === 2) return this._scaleAudioFrame(this._lastAudioFrame, 0.50)
    if (this._audioUnderrunRepeats === 3) return this._scaleAudioFrame(this._lastAudioFrame, 0.32)
    return this._makeRampToSilenceFrame()
  }

  _sendAudioFrame(frameData, synthetic = false) {
    try {
      const inputFrame = Buffer.isBuffer(frameData) ? frameData : Buffer.from(frameData)
      const normalizedFrame = inputFrame.length === FRAME_BYTES
        ? inputFrame
        : (() => {
            const out = Buffer.alloc(FRAME_BYTES)
            inputFrame.copy(out, 0, 0, Math.min(inputFrame.length, FRAME_BYTES))
            return out
          })()

      // Copy into an exact-size ArrayBuffer. Some WebRTC bindings validate
      // samples.buffer.byteLength (not just samples.byteLength), and pooled
      // Node Buffers can expose a larger backing store (e.g. 8192 bytes).
      const pcmBytes = new Uint8Array(FRAME_BYTES)
      pcmBytes.set(normalizedFrame.subarray(0, FRAME_BYTES))
      const samples = new Int16Array(pcmBytes.buffer, 0, FRAME_SAMPLES * CHANNELS)

      this._audioSource.onData({
        samples,
        sampleRate: SAMPLE_RATE,
        bitsPerSample: BITS,
        channelCount: CHANNELS,
        numberOfFrames: FRAME_SAMPLES,
      })
      if (!synthetic) this._lastAudioFrame = normalizedFrame
      this._lastAudioTailL = normalizedFrame.readInt16LE(FRAME_BYTES - 4)
      this._lastAudioTailR = normalizedFrame.readInt16LE(FRAME_BYTES - 2)
      this._audioFramesSent++
    } catch (err) {
      console.error('[Wire/Voice/DualStream] Error sending audio frame:', err.message)
    }
  }

  getVideoPosition() {
    return Math.round((this._videoFramesSent / this._targetFps) * 1000)
  }

  getAudioPosition() {
    return this._audioFramesSent * FRAME_DURATION
  }

  getVideoBufferStatus() {
    return {
      bufferedFrames: Math.floor(this._videoBuf.length / this._videoFrameBytes),
      framesSent: this._videoFramesSent,
      initialized: this._ffmpegInitialized,
      targetFps: this._targetFps,
      width: this._videoWidth,
      height: this._videoHeight,
    }
  }

  getAudioBufferStatus() {
    return {
      bufferedFrames: Math.floor(this._audioBuf.length / FRAME_BYTES),
      framesSent: this._audioFramesSent,
    }
  }
}
