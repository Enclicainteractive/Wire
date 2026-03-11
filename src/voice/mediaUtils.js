import { spawnSync } from 'child_process'

export const DEFAULT_HTTP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
export const YOUTUBE_DIRECT_HTTP_USER_AGENT = 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

export function parseFpsValue(raw) {
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

export function detectInputFpsSync(input, isUrl = false) {
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

export function isHttpInput(input) {
  return typeof input === 'string' && /^(https?):\/\//i.test(input.trim())
}

export function sanitizeMediaInput(input) {
  const normalized = typeof input === 'string' ? input.trim() : ''
  if (!normalized) return null
  if (isHttpInput(normalized)) return normalized
  return normalized
}

export function isYouTubeDirectUrl(input) {
  if (!isHttpInput(input)) return false
  try {
    const parsed = new URL(input.trim())
    const host = parsed.hostname.toLowerCase()
    if (!host.includes('googlevideo.com')) return false
    const path = parsed.pathname.toLowerCase()
    return path.includes('/videoplayback') || parsed.searchParams.has('itag') || parsed.searchParams.has('mime')
  } catch {
    return false
  }
}

function normalizeHeader(name, value) {
  const cleanName = String(name || '').replace(/[\r\n]+/g, ' ').trim()
  const cleanValue = String(value || '').replace(/[\r\n]+/g, ' ').trim()
  if (!cleanName || !cleanValue) return null
  // Conservative token validation to avoid invalid/unsafe header names.
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(cleanName)) return null
  return { name: cleanName, value: cleanValue }
}

function addHeader(map, name, value) {
  const normalized = normalizeHeader(name, value)
  if (!normalized) return
  map.set(normalized.name.toLowerCase(), normalized)
}

function parseExtraHeaders(extraHeaders) {
  const entries = []
  if (!extraHeaders) return entries

  if (Array.isArray(extraHeaders)) {
    for (const line of extraHeaders) {
      if (typeof line !== 'string') continue
      const separator = line.indexOf(':')
      if (separator <= 0) continue
      entries.push([line.slice(0, separator), line.slice(separator + 1)])
    }
    return entries
  }

  if (typeof extraHeaders === 'object') {
    for (const [name, value] of Object.entries(extraHeaders)) {
      entries.push([name, value])
    }
  }

  return entries
}

export function parseExtraHttpHeaders(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') return parsed
  } catch {}

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.length > 0 ? lines : null
}

export function buildHttpInputArgs(input, userAgent, options = null) {
  const resolvedUserAgent = typeof userAgent === 'string' && userAgent.trim()
    ? userAgent.trim()
    : DEFAULT_HTTP_USER_AGENT
  const isYouTubeDirect = options?.isYouTubeDirect === true || isYouTubeDirectUrl(input)

  const headers = new Map()
  addHeader(headers, 'User-Agent', resolvedUserAgent)
  addHeader(headers, 'Accept', '*/*')
  addHeader(headers, 'Accept-Language', 'en-US,en;q=0.9')
  addHeader(headers, 'Connection', 'keep-alive')

  if (isYouTubeDirect) {
    addHeader(headers, 'Origin', 'https://www.youtube.com')
    addHeader(headers, 'Referer', 'https://www.youtube.com/')
    addHeader(headers, 'Sec-Fetch-Mode', 'no-cors')
    addHeader(headers, 'Sec-Fetch-Site', 'cross-site')
  }

  for (const [name, value] of parseExtraHeaders(options?.extraHeaders)) {
    addHeader(headers, name, value)
  }

  const headerBlob = [...headers.values()]
    .map((entry) => `${entry.name}: ${entry.value}`)
    .join('\r\n') + '\r\n'

  return [
    '-rw_timeout', '15000000',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_delay_max', '8',
    '-user_agent', resolvedUserAgent,
    '-headers', headerBlob,
    '-i', input
  ]
}

export function buildAudioFilter(effect) {
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
    filters.push('acompressor=threshold=-20dB:ratio=4:attack=5:release=50')
  }

  if (effect.echo > 0) {
    filters.push(`aecho=0.8:0.88:${effect.echo / 200}:0.4`)
  }

  if (effect.tremolo > 0) {
    filters.push(`vibrato=f=${effect.tremolo / 10}:d=0.5`)
  }

  if (effect.robot) {
    filters.push("afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75")
  }

  if (effect.alien) {
    filters.push("afftfilt=real='cosh(0)*sin(0)':imag='cosh(0)*cos(0)':win_size=512:overlap=0.75")
  }

  return filters.length > 0 ? filters.join(',') : null
}
