const TICKET_KEYWORDS = ['order', 'ticket', 'receipt']

export function isLikelyTicketEmail(subject: string): boolean {
  const lowerSubject = subject.toLowerCase()
  return TICKET_KEYWORDS.some((keyword) => lowerSubject.includes(keyword))
}
