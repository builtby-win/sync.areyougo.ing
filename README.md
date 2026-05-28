# sync.areyougo.ing

Open-source IMAP sync service for [areyougo.ing](https://areyougo.ing).

## What This Code Does

1. **Collects your IMAP credentials** - You provide an app-specific password (not your main password)
2. **Fetches ticket emails** - ONLY from approved vendors (see list below)
3. **Forwards to areyougo.ing** - Event data extracted and sent to your account
4. **Never stores email content** - We extract event info, not personal messages

## Privacy & Security

- **Password encrypted with AES-GCM**, never logged or exposed in plaintext
- **Uses app-specific password** (not your main password) - you can revoke anytime
- **Only reads from approved senders** - no access to personal emails
- **Delete your data anytime** at https://sync.areyougo.ing

## Approved Senders (Hard-coded)

We ONLY read emails from these domains:

**Ticketing Platforms:**
- Ticketmaster (`@ticketmaster.com`, `@livenation.com`)
- AXS (`@axs.com`)
- Eventbrite (`@eventbrite.com`)
- Dice (`@dice.fm`)
- SeeTickets (`@seetickets.com`)
- Fever (`@feverup.com`)
- StubHub (`@stubhub.com`)
- Vivid Seats (`@vividseats.com`)
- SeatGeek (`@seatgeek.com`)
- Songkick (`@songkick.com`)

**Venues (SF Bay Area focus):**
- The Fillmore (`@thefillmore.com`)
- Bill Graham Civic (`@billgrahamcivic.com`)
- APE Concerts (`@apeconcerts.com`)

Full list: [src/lib/approved-senders.ts](https://github.com/builtby-win/sync.areyougo.ing/blob/main/src/lib/approved-senders.ts)

## Verify This Deployment

**Check what's running:** https://sync.areyougo.ing/api/version

Returns the exact git commit SHA deployed to Cloudflare. Compare it to commits in this repo to verify the code running matches what you see here.

The footer on the setup page also shows the running commit with a link to view it on GitHub.

## How It Works

1. **Auth**: We don't run our own auth. Your session from areyougo.ing is shared via cookie (same parent domain `.areyougo.ing`).

2. **Storage**: IMAP credentials stored in a separate Cloudflare D1 database, encrypted at rest.

3. **Sync**: An automatic cron job polls your IMAP inbox every 15 minutes (default), fetching new ticket emails and POSTing them to areyougo.ing's ingest endpoint. The interval is configurable via the `CRON_SCHEDULE` environment variable (standard cron syntax, e.g. `*/15 * * * *` for 15 minutes or `0 * * * *` for hourly).

   **Sync status**: The API separates when a sync check ran from what emails were found. `lastCheckedAt` reports when the last sync check completed (regardless of outcome). `lastImportedEmailAt` / `lastImportedEmailDate` report the newest imported email, which may be older or absent if no new emails were found since the last check.

   **Safe polling**: Do not set polling below 5 minutes. 15 minutes is the supported default for IMAP provider safety. Each failed attempt triggers exponential backoff to avoid provider rate limits. Monitor for auth failures and throttle responses in sync state.

4. **Transparency**: Every page shows the deployed commit. The `/api/version` endpoint returns deployment metadata.

## Development

```bash
pnpm install
pnpm dev       # Runs on port 4322
pnpm migrate   # Apply database migrations locally
```

## Tech Stack

- [Astro](https://astro.build) - SSR with React islands
- [Cloudflare Workers](https://workers.cloudflare.com) - Edge runtime
- [Cloudflare D1](https://developers.cloudflare.com/d1/) - SQLite database
- [Drizzle ORM](https://orm.drizzle.team) - Type-safe SQL
- [Tailwind CSS v4](https://tailwindcss.com) - Styling

## License

MIT
