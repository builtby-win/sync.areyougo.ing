/**
 * Hard-coded list of approved sender brand names.
 * We ONLY read emails from domains containing these names for privacy and transparency.
 *
 * This list is public and auditable in the GitHub repo.
 *
 * Matching is flexible - 'ticketmaster' will match:
 * - @ticketmaster.com
 * - @email.ticketmaster.com
 * - @ticketmaster.co.uk
 * - @mail.ticketmaster.net
 */
export const APPROVED_SENDERS = [
  // Major ticketing platforms
  'ticketmaster',
  'livenation',
  'axs',
  'eventbrite',
  'dice.fm',
  'seetickets',
  'feverup',
  'stubhub',
  'vividseats',
  'seatgeek',
  'tixr',

  // Secondary/resale platforms
  'gametime',
  'tickpick',

  // Venue-specific (SF Bay Area focus)
  'thefillmore',
  'billgrahamcivic',
  'apeconcerts',
  'livenationsf',
  'sfballet',
  'sfsymphony',

  // Festival platforms
  'insomniac',
  'coachella',
  'outsidelands',
] as const

export type ApprovedSender = (typeof APPROVED_SENDERS)[number]

/**
 * Check if an email address is from an approved sender
 * Uses flexible matching - the brand name just needs to appear in the domain
 * Examples for 'ticketmaster':
 * - foo@ticketmaster.com ✓
 * - foo@email.ticketmaster.com ✓
 * - foo@ticketmaster.co.uk ✓
 * - foo@mail.ticketmaster.net ✓
 */
export function isApprovedSender(email: string): boolean {
  const lowerEmail = email.toLowerCase()
  return APPROVED_SENDERS.some((sender) => {
    // Match if the domain contains the sender name
    // Pattern: @[anything.]<sender>[anything]
    // This catches any domain containing the brand name
    const escapedSender = sender.replace(/\./g, '\\.').replace(/-/g, '\\-')
    const pattern = new RegExp(`@[a-z0-9.-]*${escapedSender}[a-z0-9.-]*\\.[a-z]{2,}$`, 'i')
    return pattern.test(lowerEmail)
  })
}
