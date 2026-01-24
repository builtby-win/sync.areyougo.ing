/**
 * Hard-coded list of approved sender emails.
 * We ONLY read emails from these exact addresses for privacy and transparency.
 *
 * This list is public and auditable in the GitHub repo.
 */
export const APPROVED_SENDERS = [
  'order-support@frontgatetickets.com',
  'no-reply@tixr.com',
  'info@seetickets.us',
  'guestservices@axs.com',
  'info@ticketweb.com',
  'noreply@order.eventbrite.com',
  'customer_support@email.ticketmaster.com',
  'noreply@dice.fm',
  'events@mail.stubhub.com',
  'tickets@live.vividseats.com',
  'calendar.luma-mail.com',
  'noreply@ra.co',
  'noreply@orders.skiddle.com',
] as const

export type ApprovedSender = (typeof APPROVED_SENDERS)[number]

/**
 * Check if an email address is from an approved sender.
 * Performs an exact match against the APPROVED_SENDERS list.
 * Supports "Name <email@domain.com>" format by extracting the email.
 */
export function isApprovedSender(senderString: string): boolean {
  // Extract email if format is "Name <email@domain.com>"
  const emailMatch = senderString.match(/<([^>]+)>/)
  const email = emailMatch ? emailMatch[1] : senderString
  const lowerEmail = email.toLowerCase()

  return APPROVED_SENDERS.some((approved) => lowerEmail === approved.toLowerCase())
}
