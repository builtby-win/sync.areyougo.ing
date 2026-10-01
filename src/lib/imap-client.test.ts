import { describe, it } from 'node:test'
import assert from 'node:assert'
import { testConnection } from './imap-client'

describe('imap-client robustness', () => {
  it('gracefully handles connection failure without unhandled error events', async () => {
    // Attempt connection with invalid host/credentials
    const result = await testConnection({
      host: '127.0.0.1',
      port: 1, // Closed port
      email: 'nobody@example.com',
      password: 'wrong-password',
      encryptedPassword: '',
      iv: '',
    })

    assert.strictEqual(result.success, false)
    assert.ok(result.error)
  })
})
