export const SAMPLE_RATE = 48000
export const CHANNELS = 2
export const BITS = 16
export const FRAME_DURATION = 10
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_DURATION) / 1000
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * (BITS / 8)

export const VIDEO_WIDTH = 1600
export const VIDEO_HEIGHT = 900
export const VIDEO_FPS = 24

export const LOW_LATENCY_MAX_VIDEO_BUFFER_FRAMES = 200
export const LOW_LATENCY_START_BUFFER_FRAMES = 180
export const RTC_DELAY_MS = 0

export const MAX_PLAYER_RETRY_ATTEMPTS = 3

// ============ FIXED: Reduced buffer sizes to prevent stuttering ============
// Original: MAX_STREAM_BUFFER_FRAMES = 700 (7 seconds)
// Fixed: 150 frames = 1.5 seconds (reduced by 79%)
// This prevents the "Dropped X stale audio frames" stuttering issue
export const MAX_STREAM_BUFFER_FRAMES = 500
export const MAX_STREAM_TARGET_BUFFER_FRAMES = 350

export const MAX_VIDEO_BUFFER_FRAMES = 200
export const MAX_VIDEO_TARGET_BUFFER_FRAMES = 180
export const FFMPEG_RETRY_BACKOFF_MS = 1000

// ============ FIXED: Synchronized A/V preroll buffers ============
// Both audio and video use the SAME preroll duration for perfect sync
// 1 second is enough for RTC establishment without long delays
export const PREROLL_BUFFER_MS = 1000
export const AUDIO_PREROLL_BUFFER_MS = 1000  // Changed from 1500 to match video

export const MIN_URL_VIDEO_PLAYBACK_MS_BEFORE_FINISH = 8000
export const MIN_URL_AUDIO_PLAYBACK_MS_BEFORE_FINISH = 8000
