/**
 * Hard-coded list of approved email senders.
 * We ONLY read emails from these domains for privacy and transparency.
 *
 * This list is public and auditable in the GitHub repo.
 */
export const APPROVED_SENDERS = [
  // Major ticketing platforms
  '@ticketmaster.com',
  '@livenation.com',
  '@axs.com',
  '@eventbrite.com',
  '@dice.fm',
  '@seetickets.com',
  '@feverup.com',
  '@stubhub.com',
  '@vividseats.com',
  '@seatgeek.com',

  // Secondary/resale platforms
  '@gametime.co',
  '@tickpick.com',

  // Venue-specific (SF Bay Area focus)
  '@thefillmore.com',
  '@billgrahamcivic.com',
  '@apeconcerts.com',
  '@livenationsf.com',
  '@sfballet.org',
  '@sfsymphony.org',

  // Festival platforms
  '@insomniac.com',
  '@coachella.com',
  '@outsidelands.com',
] as const

export type ApprovedSender = (typeof APPROVED_SENDERS)[number]

/**
 * Check if an email address is from an approved sender
 */
export function isApprovedSender(email: string): boolean {
  const lowerEmail = email.toLowerCase()
  return APPROVED_SENDERS.some((sender) => lowerEmail.endsWith(sender))
}
