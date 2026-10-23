// Secret and personal-data redaction for every text stored by Relay Evals.
// Each pattern replaces its span with [REDACTED:<kind>]. Patterns run in order,
// specific provider formats first, generic heuristics last. Values are never
// logged or returned anywhere except as the redacted text.

const marker = kind => `[REDACTED:${kind}]`;
const ID_CHARS = /^[A-Za-z0-9+/_=-]+$/;
const UUID = /^(?:[A-Za-z]+[-_])?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Random-looking token: mixes lower, upper and digits with frequent class switches
// (camelCase identifiers and words switch rarely), or long hex other than a full SHA-1.
export function looksRandom(token) {
  if (token.length < 32 || !ID_CHARS.test(token) || UUID.test(token)) return false;
  // Paths such as src/components/Panel use '/', base64 secrets rarely do without + or =.
  if (token.includes('/') && !/[+]|=$/.test(token)) return false;
  if (/^[0-9a-f]+$/i.test(token)) {
    return token.length !== 40 && /\d/.test(token) && /[a-f]/i.test(token) && !/^\d+$/.test(token);
  }
  const lower = /[a-z]/.test(token), upper = /[A-Z]/.test(token), digit = /\d/.test(token);
  if (!(lower && upper && digit)) return false;
  const kind = c => /[a-z]/.test(c) ? 1 : /[A-Z]/.test(c) ? 2 : /\d/.test(c) ? 3 : 4;
  let switches = 0;
  for (let i = 1; i < token.length; i += 1) if (kind(token[i]) !== kind(token[i - 1])) switches += 1;
  // Identifiers carry long lowercase words and few digits; random tokens rarely do.
  const longestWord = Math.max(0, ...(token.match(/[a-z]+/g) || []).map(word => word.length));
  return switches >= token.length * 0.3 && digitCount(token) >= 2 && longestWord < 8;
}

const SECRET_NAME = String.raw`[\w.-]*?(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|client[_-]?secret|credentials?)[\w.-]*`;
const PLACEHOLDER = /^(?:[$<{%]|\[REDACTED|\*+$|x+$|\.\.\.)/i;

function digitCount(text) { return (text.match(/\d/g) || []).length; }

// { kind, re, replace? } — replace(match, ...groups) returns the replacement or
// null to keep the original span. Exported for the mutation tests.
export const PATTERNS = Object.freeze([
  { kind: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{0,20000}?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { kind: 'url-credentials', re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s:@/]{1,200}:[^\s@/]{1,200}@/gi,
    replace: (_match, scheme) => `${scheme}${marker('url-credentials')}@` },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'aws-key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'stripe-key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  // Vercel, Neon, Supabase, GitLab, npm, Hugging Face, xAI, Groq, DigitalOcean, Shopify style prefixes.
  { kind: 'service-token', re: /\b(?:vercel|vcp|vci|vca|vcr|vck|napi|sbp|sb_secret|sb_publishable|glpat|npm|hf|xai|gsk|dop_v1|doo_v1|shpat|shpss)_[A-Za-z0-9_-]{20,}/g },
  { kind: 'auth-header', re: /\b(Bearer|Basic)(\s+)(?=[A-Za-z0-9._~+/=-]*[0-9+/=])[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: (_match, scheme, space) => `${scheme}${space}${marker('auth-header')}` },
  { kind: 'assignment', re: new RegExp(String.raw`(\b${SECRET_NAME}["']?)(\s*(?::|=>|=)\s*)(?:(["'])([^"'\s]{4,200})\3|([^\s"'\x60,;(){}\[\]<>]{4,200}))`, 'gi'),
    replace: (_match, name, op, quote, quoted, bare) => {
      const value = quoted ?? bare;
      if (PLACEHOLDER.test(value)) return null;
      // Bare code such as `token = usage.output_tokens` or `max_tokens: 4096` stays.
      if (bare !== undefined && !((/\d/.test(bare) && /[A-Za-z]/.test(bare)) || /[!@#%^&*+=~?]/.test(bare))) return null;
      return `${name}${op}${quote ?? ''}${marker('assignment')}${quote ?? ''}`;
    } },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}\b/g,
    replace: match => /^git@/i.test(match) ? null : marker('email') },
  { kind: 'phone', re: /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?![\w])/g,
    replace: match => { const n = digitCount(match); return n >= 8 && n <= 15 ? marker('phone') : null; } },
  // Colombian mobile numbers: 3xx xxx xxxx, optionally prefixed by 57.
  { kind: 'phone', re: /(?<![\w.+/-])(?:\(?57\)?[ .-]?)?3\d{2}[ .-]?\d{3}[ .-]?\d{4}(?![\w.-])/g },
  { kind: 'digit-run', re: /(?<![\w.+-])\d(?:[ -]?\d){11,}(?![\w.])/g,
    replace: match => /^\d{8}-\d{4}-/.test(match) ? null : marker('digit-run') },
  { kind: 'high-entropy', re: /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{32,4096}(?![A-Za-z0-9+/_=-])/g,
    replace: match => looksRandom(match) ? marker('high-entropy') : null },
]);

// Builds a redactor over a pattern list (tests disable one pattern at a time).
export function createRedactor(patterns = PATTERNS) {
  return function redactWith(input) {
    let text = typeof input === 'string' ? input : input == null ? '' : String(input);
    let count = 0;
    for (const { kind, re, replace } of patterns) {
      re.lastIndex = 0;
      text = text.replace(re, (...args) => {
        const match = args[0];
        const offsetAt = args.findIndex((arg, i) => i > 0 && typeof arg === 'number');
        const out = replace ? replace(match, ...args.slice(1, offsetAt)) : marker(kind);
        if (out === null || out === match) return match;
        count += 1;
        return out;
      });
    }
    return { text, count };
  };
}

export const redact = createRedactor();
