import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 12  // Match VoltApp's Web Crypto standard
const AUTH_TAG_LENGTH = 16

const ENCRYPTION_DATA_FILE = './encryption_data.json'

const KEY_FILE_PATTERNS = [
  './e2e-keys.json',
  './data/e2e-keys.json',
  '../e2e-keys.json',
  '../data/e2e-keys.json',
  '../../e2e-keys.json',
  '../../data/e2e-keys.json',
  './encryption_data.json'
]

let cachedKeyData = null

function arrayBufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64')
}

function base64ToArrayBuffer(base64) {
  return Buffer.from(base64, 'base64')
}

function loadEncryptionData() {
  if (cachedKeyData) {
    return cachedKeyData
  }

  try {
    if (fs.existsSync(ENCRYPTION_DATA_FILE)) {
      const data = fs.readFileSync(ENCRYPTION_DATA_FILE, 'utf8')
      cachedKeyData = JSON.parse(data)
      return cachedKeyData
    }
  } catch (err) {
    console.error('[Wire Encryption] Failed to load encryption data:', err.message)
  }
  return {}
}

export function loadKeysFromBackup(filePath = null) {
  const pathsToTry = filePath ? [filePath] : KEY_FILE_PATTERNS
  
  for (const keyPath of pathsToTry) {
    try {
      if (fs.existsSync(keyPath)) {
        const content = fs.readFileSync(keyPath, 'utf8')
        const keyData = JSON.parse(content)
        
        let serverKeys = null
        
        if (keyData.serverKeys) {
          serverKeys = keyData.serverKeys
        } else if (keyData.servers) {
          serverKeys = keyData.servers
        }
        
        if (serverKeys) {
          const data = loadEncryptionData()
          if (!data.serverKeys) data.serverKeys = {}
          
          for (const [serverId, serverKeyData] of Object.entries(serverKeys)) {
            if (serverKeyData.symmetricKey) {
              data.serverKeys[serverId] = {
                symmetricKey: serverKeyData.symmetricKey,
                keyId: serverKeyData.keyId || null,
                epoch: serverKeyData.epoch || 1,
                updatedAt: serverKeyData.updatedAt || new Date().toISOString()
              }
              console.log(`[Wire Encryption] Loaded key for server ${serverId} from ${keyPath}`)
            }
          }
          
          cachedKeyData = data
          saveEncryptionData(data)
          console.log(`[Wire Encryption] Loaded ${Object.keys(serverKeys).length} server keys from ${keyPath}`)
          return { success: true, keysLoaded: Object.keys(serverKeys).length }
        }
      }
    } catch (err) {
      console.warn(`[Wire Encryption] Could not load keys from ${keyPath}:`, err.message)
    }
  }
  
  console.log('[Wire Encryption] No key backup files found')
  return { success: false, keysLoaded: 0 }
}

export function autoLoadKeys() {
  const result = loadKeysFromBackup()
  if (result.keysLoaded > 0) {
    return result
  }
  
  const data = loadEncryptionData()
  if (data.serverKeys && Object.keys(data.serverKeys).length > 0) {
    return { success: true, keysLoaded: Object.keys(data.serverKeys).length }
  }
  
  return { success: false, keysLoaded: 0 }
}

function saveEncryptionData(data) {
  try {
    fs.writeFileSync(ENCRYPTION_DATA_FILE, JSON.stringify(data, null, 2))
    return true
  } catch (err) {
    console.error('[Wire Encryption] Failed to save encryption data:', err.message)
    return false
  }
}

function generateKeyPair() {
  return crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  })
}

export function getIdentityKeys() {
  const data = loadEncryptionData()
  if (data.identity?.privateKey && data.identity?.publicKey) {
    return {
      privateKey: data.identity.privateKey,
      publicKey: data.identity.publicKey
    }
  }
  return null
}

export function generateAndStoreIdentityKeys() {
  const existing = getIdentityKeys()
  if (existing) {
    return existing
  }
  
  const keyPair = generateKeyPair()
  const data = loadEncryptionData()
  data.identity = {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    createdAt: new Date().toISOString()
  }
  saveEncryptionData(data)
  
  console.log('[Wire Encryption] Generated new identity keys')
  return data.identity
}

export function getIdentityPublicKey() {
  const keys = getIdentityKeys()
  return keys?.publicKey || null
}

function decryptWithPrivateKey(encryptedData, privateKeyPem) {
  try {
    const decrypted = crypto.privateDecrypt(
      {
        key: privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      Buffer.from(encryptedData, 'base64')
    )
    return decrypted.toString('base64')
  } catch (err) {
    console.error('[Wire Encryption] Decrypt with private key failed:', err.message)
    return null
  }
}

export function getServerKey(serverId) {
  const data = loadEncryptionData()
  return data.serverKeys?.[serverId]?.symmetricKey || null
}

function getServerKeyEntries(serverId) {
  const data = loadEncryptionData()
  const entry = data.serverKeys?.[serverId]
  if (!entry) return []

  const out = []
  if (entry.symmetricKey) {
    out.push({
      symmetricKey: entry.symmetricKey,
      keyId: entry.keyId || null,
      epoch: entry.epoch || null,
      updatedAt: entry.updatedAt || null
    })
  }
  for (const h of (entry.keyHistory || [])) {
    if (!h?.symmetricKey) continue
    out.push({
      symmetricKey: h.symmetricKey,
      keyId: h.keyId || null,
      epoch: h.epoch || null,
      updatedAt: h.updatedAt || h.rotatedAt || null
    })
  }

  const seen = new Set()
  return out.filter((k) => {
    const id = `${k.keyId || ''}:${k.epoch || ''}:${k.symmetricKey}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function addKeyHistoryEntry(history, entry) {
  if (!entry?.symmetricKey) return
  const exists = history.some((h) =>
    h.symmetricKey === entry.symmetricKey &&
    (h.keyId || null) === (entry.keyId || null) &&
    String(h.epoch || '') === String(entry.epoch || '')
  )
  if (!exists) {
    history.push({
      symmetricKey: entry.symmetricKey,
      keyId: entry.keyId || null,
      epoch: entry.epoch || null,
      rotatedAt: entry.rotatedAt || new Date().toISOString(),
      updatedAt: entry.updatedAt || new Date().toISOString()
    })
  }
}

export function setServerKey(serverId, symmetricKey, metadata = {}) {
  const data = loadEncryptionData()
  if (!data.serverKeys) data.serverKeys = {}
  const existing = data.serverKeys[serverId] || {}

  const history = Array.isArray(existing.keyHistory) ? [...existing.keyHistory] : []
  if (existing.symmetricKey && existing.symmetricKey !== symmetricKey) {
    addKeyHistoryEntry(history, {
      symmetricKey: existing.symmetricKey,
      keyId: existing.keyId || null,
      epoch: existing.epoch || null,
      rotatedAt: existing.updatedAt || new Date().toISOString(),
      updatedAt: existing.updatedAt || new Date().toISOString()
    })
  }

  data.serverKeys[serverId] = {
    ...existing,
    symmetricKey,
    keyId: metadata.keyId || existing.keyId || null,
    epoch: metadata.epoch || existing.epoch || null,
    updatedAt: metadata.updatedAt || new Date().toISOString(),
    keyHistory: history
  }
  return saveEncryptionData(data)
}

function setServerKeyHistory(serverId, history = []) {
  const data = loadEncryptionData()
  if (!data.serverKeys) data.serverKeys = {}
  const existing = data.serverKeys[serverId] || {}
  const merged = Array.isArray(existing.keyHistory) ? [...existing.keyHistory] : []
  for (const h of history) addKeyHistoryEntry(merged, h)
  data.serverKeys[serverId] = { ...existing, keyHistory: merged }
  return saveEncryptionData(data)
}

function ingestServerKeyBundle(serverId, payload = {}) {
  const current = payload.currentKey || {}
  const currentSymmetric =
    payload.symmetricKey ||
    current.senderKey ||
    current.symmetricKey ||
    payload.senderKey ||
    null

  if (currentSymmetric) {
    setServerKey(serverId, currentSymmetric, {
      keyId: current.keyId || payload.keyId || null,
      epoch: current.epoch || payload.epoch || null
    })
  }

  const history = Array.isArray(payload.keyHistory) ? payload.keyHistory : []
  if (history.length > 0) {
    setServerKeyHistory(
      serverId,
      history
        .filter(h => !!(h?.senderKey || h?.symmetricKey))
        .map(h => ({
          symmetricKey: h.senderKey || h.symmetricKey,
          keyId: h.keyId || null,
          epoch: h.epoch || null,
          rotatedAt: h.rotatedAt || null
        }))
    )
  }
}

export function getServerKeyId(serverId) {
  const data = loadEncryptionData()
  return data.serverKeys?.[serverId]?.keyId || null
}

export function setServerKeyId(serverId, keyId) {
  const data = loadEncryptionData()
  if (!data.serverKeys) data.serverKeys = {}
  if (!data.serverKeys[serverId]) data.serverKeys[serverId] = {}
  data.serverKeys[serverId].keyId = keyId
  return saveEncryptionData(data)
}

export function hasServerKey(serverId) {
  return getServerKeyEntries(serverId).length > 0
}

export function isEncryptedMessage(message) {
  if (!message?.content) return false
  const markedEncrypted = message?.encrypted === true
  const hasIvPayload = !!(message?.iv && typeof message.content === 'string')
  if (!markedEncrypted && !hasIvPayload) return false

  if (typeof message.content !== 'string') return false

  if (!message.content.startsWith('{')) {
    // Raw server format: base64 ciphertext in content + iv in message.iv
    return hasIvPayload || markedEncrypted
  }

  try {
    const parsed = JSON.parse(message.content)
    if (parsed?._encrypted === true) return true
    return !!(parsed?.iv && (parsed?.encrypted || parsed?.content))
  } catch {
    return hasIvPayload || markedEncrypted
  }
}

function getSymmetricKey(keyBase64) {
  return Buffer.from(keyBase64, 'base64')
}

export function encryptMessage(content, serverId) {
  const keyBase64 = getServerKey(serverId)
  if (!keyBase64) {
    console.error(`[Wire Encryption] No key found for server ${serverId}`)
    return { encrypted: false, content }
  }

  try {
    const key = getSymmetricKey(keyBase64)
    const iv = crypto.randomBytes(IV_LENGTH)
    
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH
    })
    
    let encrypted = cipher.update(content, 'utf8', 'base64')
    encrypted += cipher.final('base64')
    
    const authTag = cipher.getAuthTag()
    
    const encryptedPackage = {
      _encrypted: true,
      iv: arrayBufferToBase64(iv),
      content: encrypted,
      tag: arrayBufferToBase64(authTag)
    }
    
    return {
      encrypted: true,
      content: JSON.stringify(encryptedPackage),
      iv: encryptedPackage.iv
    }
  } catch (err) {
    console.error('[Wire Encryption] Encryption error:', err.message)
    return { encrypted: false, content }
  }
}

export function decryptMessage(encryptedData, serverId, messageMeta = {}) {
  const keyEntries = getServerKeyEntries(serverId)
  if (!keyEntries.length) {
    console.error(`[Wire Encryption] No key found for server ${serverId}`)
    return null
  }

  try {
    let iv
    let encrypted
    let explicitTag = null
    
    if (typeof encryptedData === 'string') {
      // Try to parse as JSON first
      try {
        const parsed = JSON.parse(encryptedData)
        
        // Check for Wire's internal format with _encrypted flag
        if (parsed._encrypted) {
          iv = base64ToArrayBuffer(parsed.iv)
          encrypted = parsed.content
          explicitTag = parsed.tag || null
        } else if (parsed.iv && parsed.encrypted) {
          // Standard format: { iv, encrypted } - auth tag embedded in encrypted
          iv = base64ToArrayBuffer(parsed.iv)
          encrypted = parsed.encrypted
        } else if (parsed.iv && parsed.content && parsed.tag) {
          // Legacy explicit-tag format: { iv, content, tag }
          iv = base64ToArrayBuffer(parsed.iv)
          encrypted = parsed.content
          explicitTag = parsed.tag
        } else {
          // Raw encrypted content from server (message.content contains encrypted data)
          // The iv should be passed separately
          return null
        }
      } catch {
        // Not JSON - might be the encrypted content itself
        return null
      }
    } else if (encryptedData.iv && (encryptedData.encrypted || encryptedData.content)) {
      // Standard format: { iv, encrypted } or { iv, content }
      // Auth tag is embedded in the last 16 bytes of the encrypted data
      iv = base64ToArrayBuffer(encryptedData.iv)
      encrypted = encryptedData.encrypted || encryptedData.content
      if (encryptedData.tag) {
        explicitTag = encryptedData.tag
      }
    } else {
      console.error('[Wire Encryption] Invalid encrypted data format')
      return null
    }

    const ordered = []
    const used = new Set()
    const addEntry = (entry) => {
      if (!entry?.symmetricKey) return
      const id = `${entry.keyId || ''}:${entry.epoch || ''}:${entry.symmetricKey}`
      if (used.has(id)) return
      used.add(id)
      ordered.push(entry)
    }

    if (messageMeta?.keyVersion) {
      keyEntries
        .filter(k => (k.keyId && k.keyId === messageMeta.keyVersion) || String(k.epoch || '') === String(messageMeta.keyVersion))
        .forEach(addEntry)
    }
    if (messageMeta?.epoch) {
      keyEntries
        .filter(k => String(k.epoch || '') === String(messageMeta.epoch))
        .forEach(addEntry)
    }
    keyEntries.forEach(addEntry)

    const encryptedBuffer = Buffer.from(encrypted, 'base64')
    let authTag
    let ciphertext
    if (explicitTag) {
      authTag = Buffer.from(explicitTag, 'base64')
      ciphertext = encryptedBuffer
    } else {
      if (encryptedBuffer.length <= AUTH_TAG_LENGTH) return null
      authTag = encryptedBuffer.subarray(encryptedBuffer.length - AUTH_TAG_LENGTH)
      ciphertext = encryptedBuffer.subarray(0, encryptedBuffer.length - AUTH_TAG_LENGTH)
    }

    for (const keyInfo of ordered) {
      try {
        const key = getSymmetricKey(keyInfo.symmetricKey)
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
          authTagLength: AUTH_TAG_LENGTH
        })
        decipher.setAuthTag(authTag)
        let decrypted = decipher.update(ciphertext, undefined, 'utf8')
        decrypted += decipher.final('utf8')
        return decrypted
      } catch {
        // Try next historical key
      }
    }

    return null
  } catch (err) {
    console.error('[Wire Encryption] Decryption error:', err.message)
    return null
  }
}

export function decryptMessageContent(message, serverId) {
  if (!isEncryptedMessage(message)) {
    return message.content
  }
  
  // Accept both explicit JSON packages and raw server format.
  let encryptedData = message.content
  if (typeof message.content === 'string' && message.content.startsWith('{')) {
    try {
      const parsed = JSON.parse(message.content)
      if (parsed?._encrypted) {
        encryptedData = parsed
      } else if (parsed?.iv && (parsed?.encrypted || parsed?.content)) {
        encryptedData = parsed
      } else if (message.iv) {
        encryptedData = { iv: message.iv, encrypted: message.content }
      }
    } catch {
      if (message.iv) encryptedData = { iv: message.iv, encrypted: message.content }
    }
  } else if (message.iv) {
    encryptedData = { iv: message.iv, encrypted: message.content }
  }

  const decrypted = decryptMessage(encryptedData, serverId, {
    keyVersion: message.keyVersion || null,
    epoch: message.epoch || null
  })
  return decrypted || message.content
}

export async function initializeEncryptionFromServer(serverId, apiClient) {
  try {
    const backupResult = loadKeysFromBackup()
    if (backupResult.keysLoaded > 0 && hasServerKey(serverId)) {
      console.log(`[Wire Encryption] Loaded key for ${serverId} from backup`)
    }

    let identityKeys = getIdentityKeys()
    if (!identityKeys) {
      console.log('[Wire Encryption] No identity keys found, generating...')
      identityKeys = generateAndStoreIdentityKeys()
    }

    if (apiClient) {
      // First try to get the auto-key (raw symmetric key - no encryption needed)
      try {
        const autoKeyData = await apiClient.getServerAutoKey(serverId)
        console.log('[Wire Encryption] Auto-key response:', JSON.stringify(autoKeyData))
        if (autoKeyData?.enabled && autoKeyData?.symmetricKey) {
          ingestServerKeyBundle(serverId, autoKeyData)
          console.log(`[Wire Encryption] Got auto-key for server ${serverId}`)
          return { hasKey: true, source: 'auto-key' }
        } else if (!autoKeyData?.enabled) {
          console.log(`[Wire Encryption] Server ${serverId} does not have encryption enabled`)
        }
      } catch (err) {
        console.warn('[Wire Encryption] Could not get auto-key:', err.message)
      }

      // Try to get user keys (encrypted symmetric key - needs identity keys to decrypt)
      try {
        const keysData = await apiClient.getUserKeysForServer(serverId)
        // Server returns direct response, not wrapped in data
        if (keysData?.currentKey?.senderKey || keysData?.keyHistory?.length) {
          ingestServerKeyBundle(serverId, keysData)
          console.log(`[Wire Encryption] Loaded key bundle for server ${serverId}`)
          return { hasKey: hasServerKey(serverId), source: 'user-key-bundle' }
        }

        if (keysData?.encryptedKey) {
          console.log(`[Wire Encryption] Got encrypted key for server ${serverId}`)
          const decryptedKey = decryptWithPrivateKey(keysData.encryptedKey, identityKeys.privateKey)
          if (decryptedKey) {
            setServerKey(serverId, decryptedKey, { keyId: keysData.keyId || null })
            console.log(`[Wire Encryption] Decrypted and stored server key for ${serverId}`)
            return { hasKey: true, source: 'user-key' }
          }
          console.error('[Wire Encryption] Failed to decrypt server key')
        }
      } catch (err) {
        console.warn('[Wire Encryption] Could not get user keys:', err.message)
      }
    }

    if (hasServerKey(serverId)) {
      return { hasKey: true, source: 'cache' }
    }

    return { hasKey: false, error: 'No key available' }
  } catch (err) {
    console.error('[Wire Encryption] Failed to initialize encryption from server:', err.message)
    return { hasKey: false, error: err.message }
  }
}

export function getEncryptionStatus(serverId) {
  const data = loadEncryptionData()
  return {
    hasKey: hasServerKey(serverId),
    keyId: getServerKeyId(serverId),
    serverId
  }
}

export function clearServerKey(serverId) {
  const data = loadEncryptionData()
  if (data.serverKeys?.[serverId]) {
    delete data.serverKeys[serverId]
    return saveEncryptionData(data)
  }
  return true
}

// Register bot's public key with server so it can receive encrypted symmetric key
export async function registerWithServer(serverId, apiClient) {
  try {
    let identityKeys = getIdentityKeys()
    if (!identityKeys) {
      identityKeys = generateAndStoreIdentityKeys()
    }
    
    // Request the server's public key info first
    const pubKeyInfo = await apiClient.getServerPublicKey(serverId)
    if (!pubKeyInfo?.data?.enabled) {
      console.log(`[Wire Encryption] Server ${serverId} does not have encryption enabled`)
      return { success: false, error: 'Encryption not enabled on server' }
    }
    
    // Get the raw symmetric key (auto-key) - this is how bots get keys without identity
    const autoKeyData = await apiClient.getServerAutoKey(serverId)
    if (autoKeyData?.data?.symmetricKey) {
      // Store the auto-key directly - bot doesn't need to decrypt anything
      setServerKey(serverId, autoKeyData.data.symmetricKey)
      if (autoKeyData.data.keyId) {
        setServerKeyId(serverId, autoKeyData.data.keyId)
      }
      console.log(`[Wire Encryption] Got auto-key for server ${serverId}`)
      return { success: true, source: 'auto-key' }
    }
    
    // Try to join using public key (for servers that require enrollment)
    try {
      const joinInfo = await apiClient.getJoinInfo(serverId)
      if (joinInfo?.data?.enabled && !joinInfo.data.hasKey) {
        // Server expects us to join with our public key
        // The server will encrypt the symmetric key for our public key
        console.log(`[Wire Encryption] Server requires enrollment, attempting to join...`)
        
        // For now, try the auto-key approach - this should work for most cases
        // In a full implementation, we'd encrypt our public key and send it
        return { success: false, error: 'Server requires manual enrollment' }
      }
    } catch (e) {
      console.warn('[Wire Encryption] Could not get join info:', e.message)
    }
    
    return { success: false, error: 'Could not get server key' }
  } catch (err) {
    console.error('[Wire Encryption] Failed to register with server:', err.message)
    return { success: false, error: err.message }
  }
}

// Initialize encryption for all servers the bot is in
export async function initializeAllEncryption(apiClient, servers) {
  const results = []
  
  for (const server of servers) {
    const serverId = server.id || server.serverId
    if (!serverId) continue
    
    // First check if we already have the key
    if (hasServerKey(serverId)) {
      results.push({ serverId, success: true, source: 'cache' })
      continue
    }
    
    // Try to load from backup first
    const backupResult = loadKeysFromBackup()
    if (backupResult.keysLoaded > 0 && hasServerKey(serverId)) {
      results.push({ serverId, success: true, source: 'backup' })
      continue
    }
    
    // Try to get from server
    if (apiClient) {
      const result = await initializeEncryptionFromServer(serverId, apiClient)
      results.push({ serverId, ...result })
    } else {
      results.push({ serverId, success: false, error: 'No API client' })
    }
  }
  
  return results
}
