/**
 * Built-in redaction patterns (NFR-4.3).
 *
 * These run in the host process before anything is transmitted (ADR-0007), so
 * they must be cheap and must not backtrack catastrophically. Every pattern is
 * anchored or bounded for that reason.
 */

export type SecretClass =
  | 'api_key'
  | 'bearer_token'
  | 'private_key'
  | 'aws_key'
  | 'connection_string'
  | 'jwt'
  | 'email'
  | 'phone'
  | 'credit_card'
  | 'ipv4'
  | 'ssn'
  | 'custom';

export interface RedactionPattern {
  readonly name: SecretClass;
  readonly pattern: RegExp;
  readonly replacement: string;
  readonly enabled: boolean;
}

/** Patterns are recreated per call because RegExp with /g carries lastIndex state. */
export function defaultPatterns(): RedactionPattern[] {
  return [
    {
      name: 'api_key',
      // OpenAI (sk-...), Anthropic (sk-ant-...), and generic long secret-ish keys.
      pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      replacement: '[REDACTED:api_key]',
      enabled: true,
    },
    {
      name: 'aws_key',
      pattern: /\b((?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16})\b/g,
      replacement: '[REDACTED:aws_key]',
      enabled: true,
    },
    {
      name: 'connection_string',
      // Any scheme://user:password@host — database URLs are the common case, and
      // a driver error will happily quote the whole thing back at you.
      // Credentials are replaced; the host survives so the log stays diagnostic.
      pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi,
      replacement: '$1$2:[REDACTED:connection_string]@',
      enabled: true,
    },
    {
      name: 'bearer_token',
      pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/g,
      replacement: 'Bearer [REDACTED:bearer_token]',
      enabled: true,
    },
    {
      name: 'private_key',
      pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
      replacement: '[REDACTED:private_key]',
      enabled: true,
    },
    {
      name: 'jwt',
      pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      replacement: '[REDACTED:jwt]',
      enabled: true,
    },
    {
      name: 'email',
      pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/g,
      replacement: '[REDACTED:email]',
      enabled: true,
    },
    {
      name: 'credit_card',
      // 13-19 digits with optional separators; validated by Luhn in the Redactor
      // so ordinary long numbers are not destroyed.
      pattern: /\b(?:\d[ -]?){13,19}\b/g,
      replacement: '[REDACTED:credit_card]',
      enabled: true,
    },
    {
      name: 'ssn',
      pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
      replacement: '[REDACTED:ssn]',
      enabled: true,
    },
    {
      name: 'phone',
      pattern: /\+\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}\b/g,
      replacement: '[REDACTED:phone]',
      enabled: true,
    },
    {
      name: 'ipv4',
      pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
      replacement: '[REDACTED:ipv4]',
      // Off by default: this pattern cannot distinguish a user's IP from a
      // service host, a version string, or a decimal-separated identifier, so
      // leaving it on mangles ordinary operational data (it redacts the server's
      // own bind address out of the startup log). Callers who need IP redaction
      // enable it explicitly via `redaction.customPatterns`.
      enabled: false,
    },
  ];
}

/** Luhn check, used to avoid redacting arbitrary long digit strings as cards. */
export function luhnValid(value: string): boolean {
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const char = digits[i];
    if (char === undefined) return false;
    let d = char.charCodeAt(0) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
