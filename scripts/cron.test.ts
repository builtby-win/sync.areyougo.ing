import test from 'node:test'
import assert from 'node:assert/strict'

test('getCronSchedule', async (t) => {
  // Save original env so each test is fully isolated
  const origCronSchedule = process.env.CRON_SCHEDULE

  t.after(() => {
    if (origCronSchedule !== undefined) {
      process.env.CRON_SCHEDULE = origCronSchedule
    } else {
      delete process.env.CRON_SCHEDULE
    }
  })

  await t.test('returns default schedule when CRON_SCHEDULE is not set', async () => {
    // given CRON_SCHEDULE is explicitly unset
    delete process.env.CRON_SCHEDULE

    // when importing with a cache-busted path
    const url = new URL('./cron.ts', import.meta.url)
    url.searchParams.set('v', String(Date.now()))
    const cronModule = await import(url.href)

    // then getCronSchedule returns the default value
    assert.strictEqual(cronModule.getCronSchedule(), '*/15 * * * *')
  })

  await t.test('reads CRON_SCHEDULE env var when set', async () => {
    // given CRON_SCHEDULE env var is overridden
    process.env.CRON_SCHEDULE = '0 */2 * * *'

    // when importing with a cache-busted path
    const url = new URL('./cron.ts', import.meta.url)
    url.searchParams.set('v', String(Date.now()))
    const cronModule = await import(url.href)

    // then getCronSchedule returns the env var value
    assert.strictEqual(cronModule.getCronSchedule(), '0 */2 * * *')
  })
})
