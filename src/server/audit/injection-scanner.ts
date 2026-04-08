export interface InjectionFinding {
  pattern_type: string;
  pattern_matched: string;
  severity: 'high';
  context: string;
}

interface InjectionPattern {
  regex: RegExp;
  type: string;
  label: string;
}

const INJECTION_PATTERNS: InjectionPattern[] = [
  {
    regex: /(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:previous|above|prior|earlier|system)\s+(?:instructions?|prompts?|rules?|constraints?)/gi,
    type: 'instruction_override', label: 'Instruction override attempt',
  },
  {
    regex: /(?:new|updated|revised|real)\s+(?:instructions?|system\s+prompt|directive)/gi,
    type: 'new_instructions', label: 'New instruction injection',
  },
  {
    regex: /(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be|your\s+new\s+role\s+is)/gi,
    type: 'role_hijack', label: 'Role hijack attempt',
  },
  {
    regex: /(?:output|print|display|reveal|show|send|transmit)\s+(?:all\s+)?(?:api\s*keys?|passwords?|secrets?|credentials?|tokens?)/gi,
    type: 'exfil_request', label: 'Data exfiltration request',
  },
  {
    regex: /(?:send|post|upload|transmit)\s+(?:to|data\s+to)\s+https?:\/\//gi,
    type: 'exfil_url', label: 'External URL exfiltration',
  },
  {
    regex: /(?:base64|b64)\s*(?:decode|exec|eval|run)/gi,
    type: 'base64_payload', label: 'Encoded payload execution',
  },
  {
    regex: /---\s*(?:END|BEGIN|SYSTEM|ADMIN|ROOT)\s*---/gi,
    type: 'delimiter_escape', label: 'Delimiter injection',
  },
  {
    regex: /<\s*(?:system|admin|root|prompt)\s*>/gi,
    type: 'xml_injection', label: 'XML-style injection',
  },
  {
    regex: /(?:DAN|do\s+anything\s+now|developer\s+mode|jailbreak)/gi,
    type: 'dan_jailbreak', label: 'Jailbreak attempt',
  },
];

export function scanForInjection(text: string): InjectionFinding[] {
  if (!text || text.length === 0) return [];
  const findings: InjectionFinding[] = [];

  for (const { regex, type, label } of INJECTION_PATTERNS) {
    const cloned = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;
    while ((match = cloned.exec(text)) !== null) {
      const start = Math.max(0, match.index - 20);
      const end = Math.min(text.length, match.index + match[0].length + 30);
      findings.push({
        pattern_type: type,
        pattern_matched: label,
        severity: 'high',
        context: text.slice(start, end).slice(0, 200),
      });
      if (cloned.lastIndex === match.index) cloned.lastIndex++;
    }
  }

  return findings;
}
