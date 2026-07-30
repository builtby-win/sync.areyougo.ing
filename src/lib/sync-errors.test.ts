import assert from 'node:assert/strict'
import { getSyncErrorMessage } from './sync-errors'

assert.match(
  getSyncErrorMessage({
    authenticationFailed: true,
    serverResponseCode: 'AUTHENTICATIONFAILED',
  }),
  /Reconnect your email account/,
)
assert.equal(getSyncErrorMessage(new Error('Mailbox unavailable')), 'Mailbox unavailable')

console.log('sync error checks passed')
