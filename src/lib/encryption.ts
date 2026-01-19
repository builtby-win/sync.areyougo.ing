/**
 * AES-GCM encryption for IMAP passwords.
 * Passwords are encrypted in the browser before submission and
 * only decrypted in the worker during IMAP connections.
 */

/**
 * Encrypt a password using AES-GCM.
 * Returns base64-encoded ciphertext and IV.
 */
export async function encryptPassword(
  password: string,
  keyBase64: string,
): Promise<{ encrypted: string; iv: string }> {
  const key = await importKey(keyBase64)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoder = new TextEncoder()
  const data = encoder.encode(password)

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)

  return {
    encrypted: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(iv),
  }
}

/**
 * Decrypt a password using AES-GCM.
 * Takes base64-encoded ciphertext and IV.
 */
export async function decryptPassword(
  encryptedBase64: string,
  ivBase64: string,
  keyBase64: string,
): Promise<string> {
  const key = await importKey(keyBase64)
  const iv = base64ToArrayBuffer(ivBase64)
  const ciphertext = base64ToArrayBuffer(encryptedBase64)

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)

  const decoder = new TextDecoder()
  return decoder.decode(plaintext)
}

/**
 * Import a base64-encoded AES-256 key.
 */
async function importKey(keyBase64: string): Promise<CryptoKey> {
  const keyBytes = base64ToArrayBuffer(keyBase64)
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

/**
 * Generate a new AES-256 key (for setup).
 */
export async function generateKey(): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
  const exported = await crypto.subtle.exportKey('raw', key)
  return arrayBufferToBase64(exported)
}

// Helpers
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}
