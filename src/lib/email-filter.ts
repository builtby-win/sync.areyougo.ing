import { isApprovedSender } from './approved-senders'

export const TICKET_KEYWORDS = ['order', 'ticket', 'receipt', 'confirmation', 'confirmed', 'booking']

export function isLikelyTicketEmail(subject: string): boolean {
  const lowerSubject = subject.toLowerCase()
  return TICKET_KEYWORDS.some((keyword) => lowerSubject.includes(keyword))
}

export function shouldProcessEmail(subject: string, from: string): boolean {
  if (!isApprovedSender(from)) {
    console.warn(`Skipping email from unapproved sender: ${from}`)
    return false
  }
  return isLikelyTicketEmail(subject)
}
