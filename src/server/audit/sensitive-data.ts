export interface SensitiveFinding {
  pattern_type: string;
  pattern_matched: string;
  severity: 'low' | 'medium' | 'high';
  context: string;
  /** The raw matched secret value (NOT stored in DB — used only during ingestion for exfil detection) */
  rawValue: string;
}

interface SensitivePattern {
  regex: RegExp;
  type: string;
  label: string;
  severity: 'low' | 'medium' | 'high';
}

export const SENSITIVE_PATTERNS: SensitivePattern[] = [
  // --- API Keys & Tokens ---
  { regex: /sk-ant-[a-zA-Z0-9\-]{20,}/g, type: 'api_key', label: 'Anthropic API key', severity: 'medium' },
  { regex: /sk-proj-[A-Za-z0-9\-_]{32,}/g, type: 'api_key', label: 'OpenAI project key', severity: 'medium' },
  { regex: /ghp_[A-Za-z0-9]{36}/g, type: 'api_key', label: 'GitHub personal access token', severity: 'medium' },
  { regex: /gho_[A-Za-z0-9]{36}/g, type: 'api_key', label: 'GitHub OAuth token', severity: 'medium' },
  { regex: /github_pat_[a-zA-Z0-9_]{22,}/g, type: 'api_key', label: 'GitHub fine-grained token', severity: 'medium' },
  { regex: /glpat-[0-9a-zA-Z\-_]{20}/g, type: 'api_key', label: 'GitLab access token', severity: 'medium' },
  { regex: /AKIA[0-9A-Z]{16}/g, type: 'aws_key', label: 'AWS access key', severity: 'medium' },
  { regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, type: 'private_key', label: 'Private key (PEM)', severity: 'medium' },
  { regex: /sk_live_[a-zA-Z0-9]{24,}/g, type: 'api_key', label: 'Stripe secret key', severity: 'medium' },
  { regex: /SG\.[0-9A-Za-z\-_]{22}\.[0-9A-Za-z\-_]{43}/g, type: 'api_key', label: 'SendGrid API key', severity: 'medium' },
  { regex: /sq0atp-[0-9A-Za-z\-_]{22}/g, type: 'api_key', label: 'Square access token', severity: 'medium' },
  { regex: /sq0csp-[0-9A-Za-z\-_]{43}/g, type: 'api_key', label: 'Square OAuth secret', severity: 'medium' },

  { regex: /xoxb-[0-9]+-[0-9]+-[A-Za-z0-9]+/g, type: 'api_key', label: 'Slack bot token', severity: 'medium' },
  { regex: /xapp-[0-9]+-[A-Z0-9]+-[0-9]+-[A-Za-z0-9]+/g, type: 'api_key', label: 'Slack app token', severity: 'medium' },
  { regex: /xox[pors]-[a-zA-Z0-9\-]{10,}/g, type: 'api_key', label: 'Slack token', severity: 'medium' },
  { regex: /AIza[0-9A-Za-z\-_]{35}/g, type: 'api_key', label: 'Google API key', severity: 'medium' },
  { regex: /npm_[a-zA-Z0-9]{36}/g, type: 'api_key', label: 'NPM access token', severity: 'medium' },
  { regex: /pypi-AgEIcHlwaS5vcmc[A-Za-z0-9\-_]{50,}/g, type: 'api_key', label: 'PyPI upload token', severity: 'medium' },
  { regex: /shpat_[a-fA-F0-9]{32}/g, type: 'api_key', label: 'Shopify access token', severity: 'medium' },
  { regex: /shpss_[a-fA-F0-9]{32}/g, type: 'api_key', label: 'Shopify shared secret', severity: 'medium' },
  { regex: /SK[0-9a-fA-F]{32}/g, type: 'api_key', label: 'Twilio API key', severity: 'medium' },
  { regex: /[MN][A-Za-z\d]{23,25}\.[A-Za-z\d]{6}\.[A-Za-z\d_\-]{27,}/g, type: 'api_key', label: 'Discord bot token', severity: 'medium' },
  { regex: /[0-9]{8,10}:[0-9A-Za-z_\-]{35}/g, type: 'api_key', label: 'Telegram bot token', severity: 'medium' },
  { regex: /EAACEdEose0cBA[0-9A-Za-z]+/g, type: 'api_key', label: 'Facebook access token', severity: 'medium' },

  // --- Tokens & Secrets ---
  { regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, type: 'jwt', label: 'JWT token', severity: 'medium' },
  { regex: /(?:mysql|postgres|postgresql|mongodb|redis):\/\/[^@]+:([^@]+)@[^\s]+/gi, type: 'database_uri', label: 'Database URI with password', severity: 'medium' },
  {
    regex: /(?:password|passwd|pwd|secret|api[_.]?key|token)\s*[=:]\s*["']?([A-Za-z0-9\/+!@#$%^&*\-_]{16,})["']?/gi,
    type: 'password', label: 'Password / secret value', severity: 'medium',
  },
  {
    regex: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?([a-zA-Z0-9\/+=]{40})["']?/g,
    type: 'aws_key', label: 'AWS secret access key', severity: 'medium',
  },
  { regex: /DefaultEndpointsProtocol=https;AccountName=[a-z0-9]+;AccountKey=[A-Za-z0-9+\/=]{88};/g, type: 'api_key', label: 'Azure storage key', severity: 'medium' },

  // --- PII ---
  { regex: /\b1[3-9]\d{9}\b/g, type: 'pii_phone_cn', label: 'Chinese phone number', severity: 'medium' },
  { regex: /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, type: 'pii_id_cn', label: 'Chinese ID card number', severity: 'medium' },
  { regex: /\b[3-6]\d{3}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, type: 'credit_card', label: 'Credit card number', severity: 'medium' },

  // --- Blockchain ---
  { regex: /\b0x[a-fA-F0-9]{40}\b/g, type: 'crypto_address', label: 'Ethereum address', severity: 'medium' },
  { regex: /\bbc1[a-zA-HJ-NP-Z0-9]{25,90}\b/g, type: 'crypto_address', label: 'Bitcoin Bech32 address', severity: 'medium' },
  {
    regex: /(?:private[_\s]?key|priv[_\s]?key)\s*[=:]\s*["']?(0x[a-fA-F0-9]{64})["']?/gi,
    type: 'blockchain_key', label: 'Blockchain private key', severity: 'medium',
  },
  { regex: /\b5[HJK][1-9A-HJ-NP-Za-km-z]{49}\b/g, type: 'blockchain_key', label: 'Bitcoin WIF private key', severity: 'medium' },
  {
    regex: /(?:mnemonic|seed|recovery)\s*(?:phrase|words?)?\s*[=:]\s*["']?((?:[a-z]{3,8}\s+){11,23}[a-z]{3,8})["']?/gi,
    type: 'mnemonic_seed', label: 'Mnemonic seed phrase', severity: 'medium',
  },

  // --- Webhooks ---
  { regex: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]{17,19}\/[A-Za-z0-9_\-]{68}/g, type: 'webhook', label: 'Discord webhook URL', severity: 'medium' },

  // --- Generic fallback ---
  {
    regex: /(?:secret|auth_token|access_token|apikey)\s*[=:]\s*["']?([a-zA-Z0-9_\-]{20,})["']?/gi,
    type: 'generic_secret', label: 'Generic secret/token', severity: 'medium',
  },
];

export function scanForSensitiveData(text: string): SensitiveFinding[] {
  if (!text || text.length === 0) return [];
  const findings: SensitiveFinding[] = [];

  // First pass: collect all matches with their positions
  const allMatches: { index: number; length: number; val: string; type: string; label: string; severity: 'low' | 'medium' | 'high' }[] = [];
  for (const { regex, type, label, severity } of SENSITIVE_PATTERNS) {
    regex.lastIndex = 0;
    const cloned = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;
    while ((match = cloned.exec(text)) !== null) {
      allMatches.push({ index: match.index, length: match[0].length, val: match[0], type, label, severity });
      if (cloned.lastIndex === match.index) cloned.lastIndex++;
    }
  }

  /** Mask a raw value: show first 6 + •••••• + last 4 */
  function maskValue(val: string, label: string): string {
    const masked = val.length <= 12
      ? val.slice(0, 3) + '••••' + val.slice(-2)
      : val.slice(0, 6) + '••••••' + val.slice(-4);
    return `[${label}: ${masked}]`;
  }

  // Build a fully-redacted version of the text, tracking position mapping
  // Sort matches by position, then by length descending (longer first for overlaps)
  const sortedByPos = [...allMatches].sort((a, b) => a.index - b.index || b.length - a.length);

  // Replace all matches in the original text to create a fully-redacted version
  // We need to track how positions shift after replacements
  let redactedText = text;
  let offset = 0; // cumulative shift from replacements
  const newPositions: { origIndex: number; newIndex: number; newLength: number }[] = [];

  for (const m of sortedByPos) {
    const replacement = maskValue(m.val, m.label);
    const adjIndex = m.index + offset;
    redactedText = redactedText.slice(0, adjIndex) + replacement + redactedText.slice(adjIndex + m.length);
    newPositions.push({ origIndex: m.index, newIndex: adjIndex, newLength: replacement.length });
    offset += replacement.length - m.length;
  }

  // Now extract context windows from the fully-redacted text
  for (let i = 0; i < allMatches.length; i++) {
    const m = allMatches[i];
    // Find this match's position in the redacted text
    const posInfo = newPositions.find(p => p.origIndex === m.index);
    if (!posInfo) continue;
    const start = Math.max(0, posInfo.newIndex - 40);
    const end = Math.min(redactedText.length, posInfo.newIndex + posInfo.newLength + 60);
    const snippet = redactedText.slice(start, end);
    findings.push({
      pattern_type: m.type,
      pattern_matched: m.label,
      severity: m.severity,
      context: snippet.slice(0, 400),
      rawValue: m.val,
    });
  }

  return findings;
}
