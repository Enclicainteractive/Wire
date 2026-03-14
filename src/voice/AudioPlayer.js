import { EventEmitter } from '../EventEmitter.js'
import { spawn } from 'child_process'
import fs from 'fs'
import { buildAudioFilter } from './mediaUtils.js'
import { SAMPLE_RATE, CHANNELS, BITS, FRAME_DURATION, FRAME_SAMPLES, FRAME_BYTES, LOW_LATENCY_MAX_VIDEO_BUFFER_FRAMES, LOW_LATENCY_START_BUFFER_FRAMES, RTC_DELAY_MS, PREROLL_BUFFER_MS, AUDIO_PREROLL_BUFFER_MS } from './constants.js'

function getFfmpegPath() {
  return process.env.WIRE_FFMPEG_PATH || process.env.FFMPEG_PATH || 'ffmpeg'
}

export class AudioPlayer extends EventEmitter {
  constructor(audioSource, filePath, loop = false, effect = null, startOffsetMs = 0) {
    super()
    this._source     = audioSource
    this._filePath   = filePath
    this._loop       = loop
    this._effect     = effect || { enabled: false, type: 'none', pitch: 0, reverb: 0, distortion: 0, echo: 0, tremolo: 0, robot: false, alien: false }
    this._startOffsetMs = Math.max(0, Number(startOffsetMs) || 0)
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
      '-analyzeduration', '0',
      '-probesize', '32',
      ...(this._startOffsetMs > 0 ? ['-ss', (this._startOffsetMs / 1000).toFixed(3)] : []),
      '-i', this._filePath,
      '-fflags', 'nobuffer',
      '-avoid_negative_ts', 'make_zero',
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
    ]

    const filter = buildAudioFilter(this._effect)
    const audioFilters = ['asetpts=N/SR/TB']
    if (filter) {
      audioFilters.push(filter)
    }
    const outputIndex = args.indexOf('-f')
    args.splice(outputIndex > 0 ? outputIndex : args.length, 0, '-af', audioFilters.join(','))

    args.push('pipe:1')

    this._ffmpeg = spawn(getFfmpegPath(), args)

    const frameSize = FRAME_BYTES
    this._ffmpeg.stdout.on('data', (chunk) => {
      this._buf = Buffer.concat([this._buf, chunk])
      // Wait for more buffer on startup to prevent cutting
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

  // Pre-buffer blank/silence frames to give time for RTC connection establishment
  _preBufferBlankFrames() {
    // 7 seconds of silence at 48kHz = 336000 samples
    // Each frame is 480 samples (10ms at 48kHz)
    // So we need 336000 / 480 = 700 frames
    const blankFrameCount = 700
    const blankData = Buffer.alloc(FRAME_BYTES) // silence is zeros
    
    // Add blank frames to buffer
    for (let i = 0; i < blankFrameCount; i++) {
      this._buf = Buffer.concat([this._buf, blankData])
    }
    
    this._log(`Pre-buffered ${blankFrameCount} blank audio frames (7s) for RTC establishment`)
  }

  _log(...args) {
    console.log(`[Wire/Voice/Audio]`, ...args)
  }

  unpause(baseStartTime = null) {
    if (!this._paused) return
    const now = Number.isFinite(baseStartTime) ? baseStartTime : Date.now()
    
    // Pre-buffer blank frames on first unpause
    if (!this._startTime) {
      this._preBufferBlankFrames()
    }
    
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
    
    // Use wall clock for accurate sync (better for A/V alignment)
    const elapsedMs = Date.now() - this._startTime - this._pausedTime
    // Subtract preroll time since that's just silence (7s for audio - more than video)
    const contentElapsedMs = Math.max(0, elapsedMs - 1500) // Updated to match new preroll
    return contentElapsedMs + RTC_DELAY_MS
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
