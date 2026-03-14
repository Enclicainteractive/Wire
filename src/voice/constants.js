export const SAMPLE_RATE = 48000
export const CHANNELS = 2
export const BITS = 16
export const FRAME_DURATION = 10
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_DURATION) / 1000
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * (BITS / 8)

export const VIDEO_WIDTH = 1600
export const VIDEO_HEIGHT = 900
export const VIDEO_FPS = 24

// Increased buffer sizes for more stable audio playback
// Larger buffers prevent audio cutting during network fluctuations
export const LOW_LATENCY_MAX_VIDEO_BUFFER_FRAMES = 250
export const LOW_LATENCY_START_BUFFER_FRAMES = 200
export const RTC_DELAY_MS = 0

export const MAX_PLAYER_RETRY_ATTEMPTS = 5

// Increased buffer sizes for smoother audio
// These prevent the "Dropped X stale audio frames" stuttering issue
export const MAX_STREAM_BUFFER_FRAMES = 600
export const MAX_STREAM_TARGET_BUFFER_FRAMES = 450

export const MAX_VIDEO_BUFFER_FRAMES = 250
export const MAX_VIDEO_TARGET_BUFFER_FRAMES = 200
export const FFMPEG_RETRY_BACKOFF_MS = 1500

// Synchronized A/V preroll buffers
// Increased to 1.5 seconds for better stability
export const PREROLL_BUFFER_MS = 1500
export const AUDIO_PREROLL_BUFFER_MS = 1500

// Minimum playback time before finish to ensure audio completes
export const MIN_URL_VIDEO_PLAYBACK_MS_BEFORE_FINISH = 10000
export const MIN_URL_AUDIO_PLAYBACK_MS_BEFORE_FINISH = 10000
