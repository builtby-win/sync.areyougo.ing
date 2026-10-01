import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getSyncErrorMessage,
  isAuthenticationError,
  isNetworkError,
  isTimeoutError,
} from './sync-errors'

describe('sync-errors', () => {
  it('identifies authentication errors correctly', () => {
    const imapError = new Error('Command failed: 1 NO [AUTHENTICATIONFAILED] Authentication Failed')
    assert.equal(isAuthenticationError(imapError), true)

    const objError = { serverResponseCode: 'AUTHENTICATIONFAILED' }
    assert.equal(isAuthenticationError(objError), true)

    const strError = 'AUTHENTICATIONFAILED: Invalid password'
    assert.equal(isAuthenticationError(strError), true)

    const nonAuthError = new Error('Socket closed unexpectedly')
    assert.equal(isAuthenticationError(nonAuthError), false)
  })

  it('provides provider-specific guidance for authentication failures', () => {
    const error = new Error('Command failed: 1 NO [AUTHENTICATIONFAILED] Authentication Failed')

    const icloudMsg = getSyncErrorMessage(error, 'icloud')
    assert.match(icloudMsg, /appleid\.apple\.com/)
    assert.match(icloudMsg, /App-Specific Password/)

    const gmailMsg = getSyncErrorMessage(error, 'gmail')
    assert.match(gmailMsg, /2-Step Verification/)

    const yahooMsg = getSyncErrorMessage(error, 'yahoo')
    assert.match(yahooMsg, /Yahoo Account security/)

    const defaultMsg = getSyncErrorMessage(error)
    assert.match(defaultMsg, /reconnect your email account/i)
  })

  it('identifies timeout and network errors', () => {
    const timeoutErr = new Error('Socket timeout while waiting for greeting')
    assert.equal(isTimeoutError(timeoutErr), true)
    assert.match(getSyncErrorMessage(timeoutErr), /timed out/)

    const connRefused = new Error('connect ECONNREFUSED 127.0.0.1:993')
    assert.equal(isNetworkError(connRefused), true)
    assert.match(getSyncErrorMessage(connRefused), /Could not reach the mail server/)
  })
})
