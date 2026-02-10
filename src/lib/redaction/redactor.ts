/**
 * Generic PII Redactor
 *
 * Detects and redacts sensitive information like:
 * - Credit card numbers (full or partial suffixes)
 * - Street addresses
 * - CVC/CVV security codes
 *
 * Designed to preserve critical numerical data like ticket prices.
 */

export function redactPii(text: string): string {
  if (!text) return text

  let redacted = text

  // 1. Credit Card Suffixes & Patterns
  // Matches "ending in 1234", "xxxx-1234", "****1234", "Visa 1234", etc.
  const ccPatterns = [
    /(?:^|\s|[^\w])(ending\s+in|xxxx-|[*]{4}|visa|mastercard|amex|discover|card)\s*[:\s-*]*(\d{4})\b/gi,
    /(?:^|\s|[^\w])(payment\s+method|card\s+ending)\s*[:\s-*]*[a-z]*\s*(\d{4})\b/gi,
  ]

  ccPatterns.forEach((pattern) => {
    redacted = redacted.replace(pattern, (match, p1, p2) => {
      // We need to preserve the leading character if it's not a word boundary
      const leadingPart = match.substring(0, match.indexOf(p1))
      const redactedPart = match.substring(match.indexOf(p1)).replace(p2, '[CC]')
      return leadingPart + redactedPart
    })
  })

  // 2. CVC / CVV
  // Matches "CVC 123", "CVV: 1234", "Security Code 123"
  const cvcPatterns = [/\b(cvc|cvv|security\s?code|security\s?number)[:\s]*(\d{3,4})\b/gi]

  cvcPatterns.forEach((pattern) => {
    redacted = redacted.replace(pattern, (match, p1, p2) => {
      return match.replace(p2, '[CVC]')
    })
  })

  // 3. Street Addresses
  // Matches: 123 Main St, 4567 Oak Avenue, 89 Generic Way
  // We look for Number + Name(s) + Suffix, potentially followed by a period.
  const streetSuffixes =
    'St|Street|Ave|Avenue|Way|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Pl|Place|Ter|Terrace'
  // Included ' for cases like O'Farrell
  // The suffix must not be followed by more words ending in another suffix,
  // which prevents partial matches like "30 St." in "30 St. John Street"
  const suffixGroup = `(?:${streetSuffixes})`
  // (?<!\.) prevents matching digits after a decimal point as a house number
  // (e.g. "$661.10 Downing Street" should NOT redact "10 Downing Street" and eat the cents)
  const addressPattern = new RegExp(
    `(?<!\\.)\\b(\\d+)\\s+([a-zA-Z0-9'\\.]+(?:\\s+[a-zA-Z0-9'\\.]+)*)\\s+(${streetSuffixes})\\b\\.?` +
    `(?!\\s+[a-zA-Z0-9'\\.]+(?:\\s+[a-zA-Z0-9'\\.]+)*\\s+${suffixGroup}\\b)`,
    'gi',
  )

  redacted = redacted.replace(addressPattern, '[STREET_ADDRESS]')

  return redacted
}
