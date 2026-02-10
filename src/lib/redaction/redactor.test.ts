import { describe, expect, it } from 'vitest'
import { redactPii } from './redactor'

describe('redactPii', () => {
  describe('Credit Card Redaction', () => {
    it('redacts card suffixes with "ending in"', () => {
      const input = 'visa ending in 1234'
      expect(redactPii(input)).toBe('visa ending in [CC]')
    })

    it('redacts masked card numbers', () => {
      expect(redactPii('card ****1111')).toBe('card ****[CC]')
      expect(redactPii('xxxx-5678')).toBe('xxxx-[CC]')
    })

    it('redacts card types followed by numbers', () => {
      expect(redactPii('Visa 1234')).toBe('Visa [CC]')
      expect(redactPii('Mastercard: 9999')).toBe('Mastercard: [CC]')
    })

    it('redacts complex payment method strings', () => {
      expect(redactPii('Payment Method: visa 1111')).toBe('Payment Method: visa [CC]')
      expect(redactPii('Card ending in 7212')).toBe('Card ending in [CC]')
    })
  })

  describe('Address Redaction', () => {
    it('redacts standard street addresses', () => {
      expect(redactPii('123 Generic St')).toBe('[STREET_ADDRESS]')
      expect(redactPii('456 Sample Ave.')).toBe('[STREET_ADDRESS]')
      expect(redactPii('2600 Geneva Avenue')).toBe('[STREET_ADDRESS]')
    })

    it('redacts multi-word street names', () => {
      expect(redactPii('425 W 11th St.')).toBe('[STREET_ADDRESS]')
      expect(redactPii("859 O'Farrell St.")).toBe('[STREET_ADDRESS]')
    })

    it('is case-insensitive for suffixes', () => {
      expect(redactPii('123 Main st')).toBe('[STREET_ADDRESS]')
      expect(redactPii('456 Oak ROAD')).toBe('[STREET_ADDRESS]')
    })

    it('redacts full address when street name contains a suffix-like word', () => {
      expect(redactPii('30 St. John Street')).toBe('[STREET_ADDRESS]')
      expect(redactPii('100 St. James Ave')).toBe('[STREET_ADDRESS]')
    })

    it('does not eat price cents when followed by a street-like name', () => {
      // "10" after a decimal is cents, not a house number — entire price + street name preserved
      expect(redactPii('$661.10 Downing Street, London')).toBe('$661.10 Downing Street, London')
      expect(redactPii('Total: $50.25 Baker Street')).toBe('Total: $50.25 Baker Street')
    })

    it('still redacts real addresses after prices', () => {
      // "250" is clearly a house number (not after a decimal), so it gets redacted
      expect(redactPii('Paid $99.99 250 Main St')).toBe('Paid $99.99 [STREET_ADDRESS]')
    })

    it('redacts standalone addresses that happen to start with common numbers', () => {
      expect(redactPii('10 Downing Street')).toBe('[STREET_ADDRESS]')
    })
  })

  describe('CVC Redaction', () => {
    it('redacts CVC labels followed by 3-4 digits', () => {
      expect(redactPii('CVC 123')).toBe('CVC [CVC]')
      expect(redactPii('CVV: 1234')).toBe('CVV: [CVC]')
      expect(redactPii('Security Code: 578')).toBe('Security Code: [CVC]')
    })
  })

  describe('Price Preservation', () => {
    it('preserves prices with dollar signs', () => {
      expect(redactPii('Total: $69.50')).toBe('Total: $69.50')
      expect(redactPii('$1,049.10')).toBe('$1,049.10')
      expect(redactPii('$ 20.00')).toBe('$ 20.00')
    })

    it('preserves standalone prices in currency formats', () => {
      expect(redactPii('GA THB 8,000')).toBe('GA THB 8,000')
      expect(redactPii('Processing Fees: + $ 13.26')).toBe('Processing Fees: + $ 13.26')
    })

    it('preserves prices without currency symbols', () => {
      expect(redactPii('Amount Charged: 183.15')).toBe('Amount Charged: 183.15')
      expect(redactPii('Total: 1049.1')).toBe('Total: 1049.1')
    })
  })

  describe('Non-PII Number Preservation', () => {
    it('preserves confirmation numbers', () => {
      expect(redactPii('Confirmation number is 46584575')).toBe('Confirmation number is 46584575')
    })

    it('preserves phone numbers (unless specifically targeted)', () => {
      expect(redactPii('888-929-7849')).toBe('888-929-7849')
    })

    it('preserves dates and times', () => {
      expect(redactPii('Mon Dec 29, 10:00 PM')).toBe('Mon Dec 29, 10:00 PM')
      expect(redactPii('11/6/2025')).toBe('11/6/2025')
    })
  })
})
