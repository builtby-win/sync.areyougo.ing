import test from 'node:test'
import assert from 'node:assert/strict'

test('getCronSchedule', async (t) => {
  await t.test('returns default schedule when CRON_SCHEDULE is not set', async () => {
    // given CRON_SCHEDULE env var is not set (testing default)

    // when importing the module fresh
    const cronModule = await import('./cron')

    // then getCronSchedule returns the default value
    const schedule = cronModule.getCronSchedule()
    assert.strictEqual(schedule, '*/15 * * * *')
  })

  await t.test('reads CRON_SCHEDULE env var when set', async () => {
    // given CRON_SCHEDULE env var is overridden
    const prevValue = process.env.CRON_SCHEDULE
    process.env.CRON_SCHEDULE = '0 */2 * * *'

    // when importing with a cache-busted path
    const url = new URL('./cron.ts', import.meta.url)
    url.searchParams.set('v', String(Date.now()))
    const cronModule = await import(url.href)

    // then getCronSchedule returns the env var value
    assert.strictEqual(cronModule.getCronSchedule(), '0 */2 * * *')

    // cleanup env
    if (prevValue !== undefined) {
      process.env.CRON_SCHEDULE = prevValue
    } else {
      delete process.env.CRON_SCHEDULE
    }
  })
})
