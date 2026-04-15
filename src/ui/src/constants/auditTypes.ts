/* ── Shared audit types, constants, and color helpers ── */

export interface Finding {
  id: number;
  audit_event_id: number;
  session_id?: string;
  agent_id?: string;
  timestamp?: number;
  pattern_type: string;
  pattern_matched: string;
  context: string;
  followed_by_external_call: number;
  severity: string;
  dismissed: number;
}

export interface EventDetail {
  id: number;
  session_id: string;
  agent_id: string;
  timestamp: number;
  event_type: string;
  tool_name: string;
  target: string;
  extra_json?: string;
  risk_flags: string;
  risk_score: number;
  raw_input: string;
  raw_output: string;
  turn_number: number;
  message_id: string | null;
  user_context: string;
  baseline?: {
    typical_hours: number[];
    avg_tool_calls_per_session: number;
    typical_paths: string[];
  } | null;
}

export interface FollowingCall {
  id: number;
  timestamp: number;
  event_type: string;
  tool_name: string;
  target: string;
  risk_score: number;
}

/** Canonical pattern → human-readable label mapping (superset of both views) */
export const PATTERN_LABELS: Record<string, string> = {
  api_key:              'API Key / Access Token',
  aws_key:              'AWS Credential',
  private_key:          'Private Cryptographic Key',
  password:             'Password / Secret Value',
  jwt:                  'JWT Token',
  database_uri:         'Database URI with Password',
  credit_card:          'Credit Card Number',
  pii:                  'Personal Data (PII)',
  pii_phone_cn:         'Phone Number (PII)',
  pii_id_cn:            'ID Card Number (PII)',
  crypto:               'Blockchain Key / Mnemonic',
  crypto_address:       'Blockchain Address',
  blockchain_key:       'Blockchain Private Key',
  mnemonic_seed:        'Mnemonic Seed Phrase',
  webhook:              'Webhook URL',
  generic_secret:       'Secret / Token',
  prompt_injection:     'Prompt Injection',
  // Injection sub-types
  instruction_override: 'Prompt Injection — Instruction Override',
  new_instructions:     'Prompt Injection — New Instructions',
  role_hijack:          'Prompt Injection — Role Hijack',
  exfil_request:        'Prompt Injection — Exfil Request',
  exfil_url:            'Prompt Injection — External URL Exfil',
  base64_payload:       'Prompt Injection — Encoded Payload',
  delimiter_escape:     'Prompt Injection — Delimiter Escape',
  xml_injection:        'Prompt Injection — XML Injection',
  dan_jailbreak:        'Prompt Injection — Jailbreak Attempt',
};


/** Map severity string → CSS color variable */
export function severityColor(s: string): string {
  if (s === 'high')   return 'var(--C-rose)';
  if (s === 'medium') return 'var(--C-amber)';
  if (s === 'none')   return 'var(--muted)';
  return 'var(--C-green)';
}
