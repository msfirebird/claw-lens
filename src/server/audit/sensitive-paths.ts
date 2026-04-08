import { minimatch } from 'minimatch';

export interface SensitivePathRule {
  pattern: string;
  severity: 'low' | 'medium' | 'none';
  label: string;
}

const DEFAULT_SENSITIVE_PATTERNS: SensitivePathRule[] = [
  // Whitelist — never flag OpenClaw workspace reads
  { pattern: '**/.openclaw/workspace/**', severity: 'none', label: 'OpenClaw workspace' },
  { pattern: '**/.openclaw/agents/**', severity: 'none', label: 'OpenClaw agent data' },

  // SSH
  { pattern: '**/.ssh/**', severity: 'low', label: 'SSH directory' },
  { pattern: '**/id_rsa', severity: 'medium', label: 'SSH private key' },
  { pattern: '**/id_ed25519', severity: 'medium', label: 'SSH private key' },
  { pattern: '**/id_ecdsa', severity: 'medium', label: 'SSH private key' },

  // Environment / credentials
  { pattern: '**/.env', severity: 'medium', label: 'Environment file' },
  { pattern: '**/.env.*', severity: 'medium', label: 'Environment file' },
  { pattern: '**/*.env', severity: 'low', label: 'Environment file' },

  // Name-based matches
  { pattern: '**/*password*', severity: 'medium', label: 'Password file' },
  { pattern: '**/*secret*', severity: 'medium', label: 'Secret file' },
  { pattern: '**/*credential*', severity: 'medium', label: 'Credential file' },
  { pattern: '**/*token*', severity: 'low', label: 'Token file' },

  // macOS keychain
  { pattern: '**/Library/Keychains/**', severity: 'medium', label: 'macOS Keychain' },

  // Common config files with secrets
  { pattern: '**/.netrc', severity: 'medium', label: 'Netrc credentials' },
  { pattern: '**/.pgpass', severity: 'medium', label: 'PostgreSQL password' },
  { pattern: '**/config/credentials.yml*', severity: 'medium', label: 'Rails credentials' },
  { pattern: '**/*.pem', severity: 'low', label: 'PEM certificate/key' },
  { pattern: '**/*.p12', severity: 'low', label: 'PKCS12 keystore' },
  { pattern: '**/*.pfx', severity: 'low', label: 'PKCS12 keystore' },
];

export function isSensitivePath(
  filePath: string
): SensitivePathRule | null {
  const allPatterns = DEFAULT_SENSITIVE_PATTERNS;
  // Check whitelist first (severity: 'none')
  for (const rule of allPatterns) {
    if (rule.severity === 'none' && minimatch(filePath, rule.pattern, { dot: true })) {
      return null;
    }
  }
  for (const rule of allPatterns) {
    if (rule.severity !== 'none' && minimatch(filePath, rule.pattern, { dot: true })) {
      return rule;
    }
  }
  return null;
}

