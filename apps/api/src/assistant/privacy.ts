/**
 * Small, conservative PII scrubber used before any assistant text is placed in
 * a prompt or returned as a classifier hint.  It intentionally favours false
 * positives over leaking an identifier: context is advisory, while a leaked
 * phone/email/account number is not recoverable.
 */

const MAX_REDACTION_LENGTH = 2_000;

function compactDigits(value: string): string {
  return value.replace(/[^\d]/g, '');
}

/**
 * Redact common direct identifiers while preserving the surrounding words
 * needed for retrieval/classification.  The function is deterministic and
 * bounded so hostile input cannot inflate a prompt.
 */
export function redactPii(
  value: string,
  maxLength = MAX_REDACTION_LENGTH,
): string {
  if (typeof value !== 'string') return '';
  let redacted = value;

  // IBANs and card/account-like digit runs must be handled before phone
  // numbers, otherwise the latter can consume part of the identifier.
  redacted = redacted.replace(
    /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/gi,
    '[iban]',
  );
  redacted = redacted.replace(
    /\b(?:\d[ -]?){13,19}\b/g,
    (candidate) =>
      compactDigits(candidate).length >= 13 ? '[card]' : candidate,
  );
  redacted = redacted.replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    '[email]',
  );
  redacted = redacted.replace(
    /(?:\+?\d[\d\s().-]{6,}\d)/g,
    (candidate) => {
      const digits = compactDigits(candidate);
      if (/^\d{4}-\d{2}(?:-\d{2})?$/.test(candidate.trim())) {
        return candidate;
      }
      return digits.length >= 7 && digits.length <= 15 ? '[phone]' : candidate;
    },
  );

  // Explicit name/identity labels in free-form reports.  This is deliberately
  // narrower than redacting every capitalised word, which would destroy Greek
  // legal terminology and make the classifier useless.
  redacted = redacted.replace(
    /\b(?:ονοματεπώνυμο|όνομα|owner|resident|χρήστης|κάτοικος|name)\s*[:=]\s*[^\n,;]+/giu,
    (_match, label: string) => `${label}: [name]`,
  );
  redacted = redacted.replace(
    /\b(?:my name is|i am|ονομάζομαι|λέγομαι)\s+[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){1,3}/giu,
    '[name]',
  );
  // A bare two/three-word capitalised sequence is commonly a person name in
  // reports. Redact it conservatively rather than returning it to a model.
  redacted = redacted.replace(
    /\b\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){1,2}\b/gu,
    '[name]',
  );
  redacted = redacted.replace(
    /\b(?:ΑΦΜ|AFM|tax\s*id|passport|id\s*number)\s*[:=]?\s*[A-Z0-9-]{6,}\b/giu,
    '[personal-id]',
  );

  return redacted.slice(0, Math.max(0, maxLength));
}

export function redactContextValue(value: string): string {
  return redactPii(value, 1_500);
}
