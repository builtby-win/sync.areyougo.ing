import assert from 'node:assert/strict'
import test from 'node:test'

import { buildIngestPayload } from './ingest'

test('buildIngestPayload returns flat ingest fields for cron emails', () => {
  const payload = buildIngestPayload({
    userId: 'user_123',
    recipientEmail: 'huntersgordon@gmail.com',
    email: {
      messageId: '<message-id>',
      from: 'Skiddle <noreply@orders.skiddle.com>',
      subject: 'Your ticket confirmation',
      body: 'Doors at 8pm',
      date: new Date('2026-04-21T12:34:56.000Z'),
    },
  })

  assert.deepEqual(payload, {
    userId: 'user_123',
    recipientEmail: 'huntersgordon@gmail.com',
    senderEmail: 'noreply@orders.skiddle.com',
    subject: 'Your ticket confirmation',
    body: 'Doors at 8pm',
    emailDate: '2026-04-21T12:34:56.000Z',
  })

  assert.equal('email' in payload, false)
})

test('buildIngestPayload preserves string dates from manual ingestion sessions', () => {
  const payload = buildIngestPayload({
    userId: 'user_456',
    recipientEmail: 'user@example.com',
    email: {
      messageId: '<message-id-2>',
      from: 'Dice <hello@dice.fm>',
      subject: 'Manual sync result',
      body: 'See you there',
      date: '2026-04-22T01:02:03.000Z',
    },
  })

  assert.equal(payload.emailDate, '2026-04-22T01:02:03.000Z')
  assert.equal(payload.senderEmail, 'hello@dice.fm')
})
