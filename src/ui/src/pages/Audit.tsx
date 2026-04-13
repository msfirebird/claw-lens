import { useState, useRef, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useFetch, fmtDatetime } from '../hooks';
import { PageHeader, KpiStrip, Kpi } from '../components/ui';
import DataAccessTimeline from '../components/DataAccessTimeline';
import AgentSecurityPanel from '../components/AgentSecurityPanel';
import { severityColor } from '../constants/auditTypes';

/* ─── shared styles ─── */
const sevSpan = (s: string, muted?: boolean): CSSProperties => ({ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.05em', color: muted ? 'var(--muted)' : severityColor(s) });
const badgeStyle = (color: string): CSSProperties => ({ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', padding: '1px 6px', borderRadius: 'var(--radius-sm)', border: `1px solid ${color}`, color });
const tblFlush: CSSProperties = { margin: 0 };

/* ─── Audit Rule Card wrapper ─── */
function AuditRuleCard({ name, desc, badge, badgeColor, defaultOpen, children }: {
  name: string; desc: string; badge?: string; badgeColor?: string; defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <div style={{ margin: '0 var(--space-6) var(--space-4)', border: '1px solid var(--border)' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-3)', width: '100%',
          padding: 'var(--space-3) var(--space-4)', background: 'var(--surface)', border: 'none',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--muted)', width: 12, flexShrink: 0 }}>{open ? '\u25BC' : '\u25B6'}</span>
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', minWidth: 150 }}>{name}</span>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--muted)' }}>{desc}</span>
        {badge && <span style={badgeStyle(badgeColor || 'var(--muted)')}>{badge}</span>}
      </button>
      {open && (
        <div style={{ padding: 'var(--space-4)', borderTop: '1px solid var(--border)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

/* ─── Sensitive Data Patterns (read-only) ─── */
const BUILTIN_DATA_PATTERNS = [
  { regex: 'sk-ant-[a-zA-Z0-9\\-]{20,}', labelKey: 'audit.builtInDataPatterns.anthropicKey', severity: 'medium' },
  { regex: 'sk-proj-[A-Za-z0-9\\-_]{32,}', labelKey: 'audit.builtInDataPatterns.openaiKey', severity: 'medium' },
  { regex: 'ghp_*, gho_*, github_pat_*', labelKey: 'audit.builtInDataPatterns.githubToken', severity: 'medium' },
  { regex: 'glpat-[0-9a-zA-Z\\-_]{20}', labelKey: 'audit.builtInDataPatterns.gitlabToken', severity: 'medium' },
  { regex: 'AKIA[0-9A-Z]{16}', labelKey: 'audit.builtInDataPatterns.awsKey', severity: 'medium' },
  { regex: 'AWS_SECRET_ACCESS_KEY = ...', labelKey: 'audit.builtInDataPatterns.awsSecret', severity: 'medium' },
  { regex: '-----BEGIN (?:RSA )?PRIVATE KEY-----', labelKey: 'audit.builtInDataPatterns.pemKey', severity: 'medium' },
  { regex: 'sk_live_[a-zA-Z0-9]{24,}', labelKey: 'audit.builtInDataPatterns.stripeKey', severity: 'medium' },
  { regex: 'SG.[0-9A-Za-z\\-_]{22}...', labelKey: 'audit.builtInDataPatterns.sendgridKey', severity: 'medium' },
  { regex: 'sq0atp-*, sq0csp-*', labelKey: 'audit.builtInDataPatterns.squareToken', severity: 'medium' },
  { regex: 'xoxb-*, xapp-*, xox[pors]-*', labelKey: 'audit.builtInDataPatterns.slackToken', severity: 'medium' },
  { regex: 'AIza[0-9A-Za-z\\-_]{35}', labelKey: 'audit.builtInDataPatterns.googleKey', severity: 'medium' },
  { regex: 'npm_*, pypi-*', labelKey: 'audit.builtInDataPatterns.packageToken', severity: 'medium' },
  { regex: 'shpat_*, shpss_*', labelKey: 'audit.builtInDataPatterns.shopifyToken', severity: 'medium' },
  { regex: 'SK[0-9a-fA-F]{32}', labelKey: 'audit.builtInDataPatterns.twilioKey', severity: 'medium' },
  { regex: '[0-9]{8,10}:[0-9A-Za-z_\\-]{35}', labelKey: 'audit.builtInDataPatterns.telegramToken', severity: 'medium' },
  { regex: 'Discord / Facebook bot tokens', labelKey: 'audit.builtInDataPatterns.socialToken', severity: 'medium' },
  { regex: 'DefaultEndpointsProtocol=...', labelKey: 'audit.builtInDataPatterns.azureKey', severity: 'medium' },
  { regex: 'eyJ...JWT pattern', labelKey: 'audit.builtInDataPatterns.jwt', severity: 'medium' },
  { regex: 'mysql|postgres://...@', labelKey: 'audit.builtInDataPatterns.dbUri', severity: 'medium' },
  { regex: 'password|secret|api_key = "..."', labelKey: 'audit.builtInDataPatterns.password', severity: 'medium' },
  { regex: 'secret|auth_token|apikey = "..."', labelKey: 'audit.builtInDataPatterns.genericSecret', severity: 'medium' },
  { regex: 'Discord webhook URL', labelKey: 'audit.builtInDataPatterns.discordWebhook', severity: 'medium' },
  { regex: '\\b1[3-9]\\d{9}\\b', labelKey: 'audit.builtInDataPatterns.cnPhone', severity: 'medium' },
  { regex: '\\b\\d{6}(19|20)\\d{10}[\\dXx]\\b', labelKey: 'audit.builtInDataPatterns.cnId', severity: 'medium' },
  { regex: '\\b\\d{4}[-\\s]?\\d{4}[-\\s]?\\d{4}[-\\s]?\\d{4}\\b', labelKey: 'audit.builtInDataPatterns.creditCard', severity: 'medium' },
  { regex: '0x[a-fA-F0-9]{40}, bc1...', labelKey: 'audit.builtInDataPatterns.cryptoAddress', severity: 'medium' },
  { regex: 'private_key = 0x..., 5[HJK]...', labelKey: 'audit.builtInDataPatterns.blockchainKey', severity: 'medium' },
  { regex: 'mnemonic|seed phrase = "..."', labelKey: 'audit.builtInDataPatterns.mnemonic', severity: 'medium' },
];

function SensitiveDataPatternsReadonly() {
  const { t } = useTranslation();
  return (
    <div className="tbl" style={tblFlush}>
      <table>
        <thead><tr><th>{t('audit.pattern')}</th><th>{t('audit.label')}</th><th>{t('audit.severity')}</th></tr></thead>
        <tbody>
          {BUILTIN_DATA_PATTERNS.map(r => (
            <tr key={r.labelKey}>
              <td className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{r.regex}</td>
              <td style={{ fontSize: 12, color: 'var(--muted)' }}>{t(r.labelKey)}</td>
              <td><span style={sevSpan(r.severity, true)}>{t(`common.${r.severity}`)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Dangerous Commands (read-only) ─── */
const CRITICAL_COMMANDS = [
  { pattern: 'rm -rf', descKey: 'audit.criticalCmds.rmRf' },
  { pattern: 'curl/wget ... | bash/sh', descKey: 'audit.criticalCmds.curlBash' },
  { pattern: 'chmod +s', descKey: 'audit.criticalCmds.chmodSuid' },
  { pattern: 'chmod 777', descKey: 'audit.criticalCmds.chmod777' },
  { pattern: 'dd if=... of=/dev/', descKey: 'audit.criticalCmds.ddDev' },
  { pattern: 'iptables -F', descKey: 'audit.criticalCmds.iptablesF' },
  { pattern: 'mkfs', descKey: 'audit.criticalCmds.mkfs' },
  { pattern: 'echo ... > /etc/', descKey: 'audit.criticalCmds.echoEtc' },
];
const ELEVATED_COMMANDS = [
  { pattern: 'sudo', descKey: 'audit.elevatedCmds.sudo' },
  { pattern: 'ssh / scp / rsync', descKey: 'audit.elevatedCmds.ssh' },
  { pattern: 'curl / wget', descKey: 'audit.elevatedCmds.curl' },
  { pattern: 'nc / netcat / ftp', descKey: 'audit.elevatedCmds.nc' },
  { pattern: 'cat .env / passwd / shadow', descKey: 'audit.elevatedCmds.catEnv' },
  { pattern: 'chown root', descKey: 'audit.elevatedCmds.chownRoot' },
];

function DangerousCommandsReadonly() {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', gap: 'var(--space-6)', flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 280 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--C-rose)', marginBottom: 'var(--space-2)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{t('audit.criticalHighRisk')}</div>
        <div className="tbl" style={tblFlush}><table><thead><tr><th>{t('audit.pattern')}</th><th>{t('audit.description')}</th></tr></thead><tbody>
          {CRITICAL_COMMANDS.map(c => (<tr key={c.pattern}><td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{c.pattern}</td><td style={{ fontSize: 12, color: 'var(--muted)' }}>{t(c.descKey)}</td></tr>))}
        </tbody></table></div>
      </div>
      <div style={{ flex: 1, minWidth: 280 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--C-amber)', marginBottom: 'var(--space-2)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{t('audit.elevatedMediumRisk')}</div>
        <div className="tbl" style={tblFlush}><table><thead><tr><th>{t('audit.pattern')}</th><th>{t('audit.description')}</th></tr></thead><tbody>
          {ELEVATED_COMMANDS.map(c => (<tr key={c.pattern}><td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{c.pattern}</td><td style={{ fontSize: 12, color: 'var(--muted)' }}>{t(c.descKey)}</td></tr>))}
        </tbody></table></div>
      </div>
    </div>
  );
}

/* ─── Prompt Injection Patterns (read-only) ─── */
const INJECTION_PATTERNS_DISPLAY = [
  { typeKey: 'audit.injectionPatterns.instructionOverride', descKey: 'audit.injectionPatterns.instructionOverrideDesc' },
  { typeKey: 'audit.injectionPatterns.newInstructions', descKey: 'audit.injectionPatterns.newInstructionsDesc' },
  { typeKey: 'audit.injectionPatterns.roleHijack', descKey: 'audit.injectionPatterns.roleHijackDesc' },
  { typeKey: 'audit.injectionPatterns.exfilRequest', descKey: 'audit.injectionPatterns.exfilRequestDesc' },
  { typeKey: 'audit.injectionPatterns.exfilUrl', descKey: 'audit.injectionPatterns.exfilUrlDesc' },
  { typeKey: 'audit.injectionPatterns.encodedPayload', descKey: 'audit.injectionPatterns.encodedPayloadDesc' },
  { typeKey: 'audit.injectionPatterns.delimiterEscape', descKey: 'audit.injectionPatterns.delimiterEscapeDesc' },
  { typeKey: 'audit.injectionPatterns.xmlInjection', descKey: 'audit.injectionPatterns.xmlInjectionDesc' },
  { typeKey: 'audit.injectionPatterns.jailbreak', descKey: 'audit.injectionPatterns.jailbreakDesc' },
];

function InjectionPatternsReadonly() {
  const { t } = useTranslation();
  return (
    <div className="tbl" style={tblFlush}><table><thead><tr><th>{t('audit.patternType')}</th><th>{t('audit.detects')}</th></tr></thead><tbody>
      {INJECTION_PATTERNS_DISPLAY.map(p => (<tr key={p.typeKey}><td style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{t(p.typeKey)}</td><td style={{ fontSize: 12, color: 'var(--muted)' }}>{t(p.descKey)}</td></tr>))}
    </tbody></table></div>
  );
}

/* ─── Data Exfiltration Detection (read-only) ─── */
function DataExfiltrationReadonly() {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--C-rose)', marginBottom: 'var(--space-2)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{t('audit.exfilCommandPatterns')}</div>
        <div className="tbl" style={tblFlush}><table><thead><tr><th>{t('audit.pattern')}</th><th>{t('audit.description')}</th></tr></thead><tbody>
          <tr><td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>curl -F file=@/path URL</td><td style={{ fontSize: 12, color: 'var(--muted)' }}>{t('audit.exfilCmds.curlUpload')}</td></tr>
          <tr><td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>curl --data-binary @/path URL</td><td style={{ fontSize: 12, color: 'var(--muted)' }}>{t('audit.exfilCmds.curlDataBinary')}</td></tr>
          <tr><td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>curl --upload-file /path URL</td><td style={{ fontSize: 12, color: 'var(--muted)' }}>{t('audit.exfilCmds.curlUploadFile')}</td></tr>
          <tr><td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>cat /path | curl/wget</td><td style={{ fontSize: 12, color: 'var(--muted)' }}>{t('audit.exfilCmds.pipeToNetwork')}</td></tr>
          <tr><td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>scp /local/file user@remote:</td><td style={{ fontSize: 12, color: 'var(--muted)' }}>{t('audit.exfilCmds.scpOut')}</td></tr>
        </tbody></table></div>
      </div>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--C-rose)', marginBottom: 'var(--space-2)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{t('audit.exfilCredentialEscalation')}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>{t('audit.exfilCredentialEscalationDesc')}</div>
      </div>
    </div>
  );
}

/* ─── Anomaly Detection (read-only) ─── */
function AnomalyDetectionReadonly() {
  const { t } = useTranslation();
  const anomalyItems = [
    { signalKey: 'audit.anomalySignals.unusualHours', descKey: 'audit.anomalySignals.unusualHoursDesc' },
    { signalKey: 'audit.anomalySignals.unusualVolume', descKey: 'audit.anomalySignals.unusualVolumeDesc' },
    { signalKey: 'audit.anomalySignals.unusualPath', descKey: 'audit.anomalySignals.unusualPathDesc' },
    { signalKey: 'audit.anomalySignals.newDomain', descKey: 'audit.anomalySignals.newDomainDesc' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      {anomalyItems.map(a => (
        <div key={a.signalKey} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-2) var(--space-3)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div style={{ minWidth: 130, fontWeight: 600, fontSize: 12, color: 'var(--C-green)' }}>{t(a.signalKey)}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t(a.descKey)}</div>
        </div>
      ))}
    </div>
  );
}

/* ─── Sensitive Paths (read-only) ─── */
const BUILTIN_PATH_RULES = [
  { pattern: '**/.ssh/**', labelKey: 'audit.builtInPathRules.sshDir', severity: 'low' },
  { pattern: '**/id_rsa, **/id_ed25519, **/id_ecdsa', labelKey: 'audit.builtInPathRules.sshKey', severity: 'medium' },
  { pattern: '**/.env, **/.env.*', labelKey: 'audit.builtInPathRules.envFile', severity: 'medium' },
  { pattern: '**/*.env', labelKey: 'audit.builtInPathRules.envWildcard', severity: 'low' },
  { pattern: '**/*password*, **/*secret*, **/*credential*', labelKey: 'audit.builtInPathRules.passwordFile', severity: 'medium' },
  { pattern: '**/*token*', labelKey: 'audit.builtInPathRules.tokenFile', severity: 'low' },
  { pattern: '**/Library/Keychains/**', labelKey: 'audit.builtInPathRules.keychain', severity: 'medium' },
  { pattern: '**/.netrc, **/.pgpass', labelKey: 'audit.builtInPathRules.configCreds', severity: 'medium' },
  { pattern: '**/config/credentials.yml*', labelKey: 'audit.builtInPathRules.railsCreds', severity: 'medium' },
  { pattern: '**/*.pem, **/*.p12, **/*.pfx', labelKey: 'audit.builtInPathRules.certFile', severity: 'low' },
  { pattern: '**/.openclaw/workspace/**', labelKey: 'audit.builtInPathRules.openclawWorkspace', severity: 'none' },
  { pattern: '**/.openclaw/agents/**', labelKey: 'audit.builtInPathRules.openclawAgents', severity: 'none' },
];

function SensitivePathRulesReadonly() {
  const { t } = useTranslation();
  return (
    <div className="tbl" style={tblFlush}><table><thead><tr><th>{t('audit.pattern')}</th><th>{t('audit.label')}</th><th>{t('audit.severity')}</th></tr></thead><tbody>
      {BUILTIN_PATH_RULES.map(r => (<tr key={r.pattern}><td className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{r.pattern}</td><td style={{ fontSize: 12, color: 'var(--muted)' }}>{t(r.labelKey)}</td><td><span style={sevSpan(r.severity, true)}>{r.severity === 'none' ? t('audit.noneWhitelist') : t(`common.${r.severity}`)}</span></td></tr>))}
    </tbody></table></div>
  );
}





const RISK_COLORS: Record<string, string> = {
  high:   'var(--C-rose)',
  medium: 'var(--C-amber)',
  low:    'var(--C-green)',
};

const sty = { label: { fontSize: 11.5, color: 'var(--muted)', marginTop: 4 } as CSSProperties };

function buildEventTypeTooltip(t: (key: string) => string) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>
        {t('audit.eventTypeTooltipIntro')}
      </div>
      {[
        { icon: '\u{1F4C4}', typeKey: 'audit.eventTypes.fileRead', descKey: 'audit.infoFileRead' },
        { icon: '\u270F\uFE0F', typeKey: 'audit.eventTypes.fileWrite', descKey: 'audit.infoFileWrite' },
        { icon: '\u26A1', typeKey: 'audit.eventTypes.exec', descKey: 'audit.infoExec' },
        { icon: '\u{1F310}', typeKey: 'audit.eventTypes.webFetch', descKey: 'audit.infoWebFetch' },
        { icon: '\u{1F50D}', typeKey: 'audit.eventTypes.webSearch', descKey: 'audit.infoWebSearch' },
      ].map(e => (
        <div key={e.typeKey} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span style={{ fontSize: 14, flexShrink: 0 }}>{e.icon}</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{t(e.typeKey)}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>{t(e.descKey)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function buildRiskTooltip(t: (key: string) => string) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* High */}
      <div>
        <div style={{ fontSize: 13, marginBottom: 2 }}><span style={{ fontWeight: 600, color: 'var(--C-rose)' }}>{t('audit.riskHigh')}</span> <span style={{ color: 'var(--muted)' }}>{t('audit.riskHighDesc')}</span></div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>{t('audit.riskHighAction')}</div>
        <div style={{ height: 1, background: 'var(--border)', margin: '4px 0 8px' }} />
        <div style={sty.label}>{t('audit.descDataLeak')}</div>
        <div style={sty.label}>{t('audit.descDestructiveCmd')}</div>
        <div style={sty.label}>{t('audit.descPromptInjection')}</div>
        <div style={sty.label}>{t('audit.descCredentialExfil')}</div>
      </div>
      {/* Medium */}
      <div>
        <div style={{ fontSize: 13, marginBottom: 2 }}><span style={{ fontWeight: 600, color: 'var(--C-amber)' }}>{t('audit.riskMedium')}</span> <span style={{ color: 'var(--muted)' }}>{t('audit.riskMediumDesc')}</span></div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>{t('audit.riskMediumAction')}</div>
        <div style={{ height: 1, background: 'var(--border)', margin: '4px 0 8px' }} />
        <div style={sty.label}>{t('audit.descCredentialExposed')}</div>
        <div style={sty.label}>{t('audit.descElevatedCmd')}</div>
        <div style={sty.label}>{t('audit.descUnknownDomain')}</div>
      </div>
      {/* Low */}
      <div>
        <div style={{ fontSize: 13, marginBottom: 2 }}><span style={{ fontWeight: 600, color: 'var(--C-green)' }}>{t('audit.riskLow')}</span> <span style={{ color: 'var(--muted)' }}>{t('audit.riskLowDesc')}</span></div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>{t('audit.riskLowAction')}</div>
        <div style={{ height: 1, background: 'var(--border)', margin: '4px 0 8px' }} />
        <div style={sty.label}>{t('audit.descSensitivePath')}</div>
        <div style={sty.label}>{t('audit.descUnusualHours')}</div>
        <div style={sty.label}>{t('audit.descUnusualVolume')}</div>
      </div>
    </div>
  );
}

const chipBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 10px',
  borderRadius: 'var(--radius-full)',
  fontSize: 12,
  cursor: 'pointer',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--muted)',
  transition: 'background .15s, color .15s, border-color .15s',
  userSelect: 'none' as const,
  whiteSpace: 'nowrap' as const,
};

function Chip({ label, active, color, onClick }: { label: string; active: boolean; color?: string; onClick: () => void }) {
  const bg = active ? (color || 'var(--C-blue)') : 'transparent';
  const fg = active ? '#fff' : 'var(--muted)';
  const borderColor = active ? (color || 'var(--C-blue)') : 'var(--border)';
  return (
    <button
      onClick={onClick}
      style={{
        ...chipBase,
        background: bg,
        color: fg,
        borderColor,
      }}
    >
      {label}
    </button>
  );
}

function TooltipIcon({ text, content }: { text?: string; content?: ReactNode }) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <span
        ref={ref}
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        style={{
          cursor: 'help',
          fontSize: 9,
          color: 'var(--muted)',
          border: '1px solid var(--border)',
          borderRadius: '50%',
          width: 13,
          height: 13,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          lineHeight: 1,
        }}
      >?</span>
      {show && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          marginTop: 6,
          background: 'var(--surface2)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          padding: '10px 12px',
          fontSize: 12,
          color: 'var(--text)',
          width: 840,
          lineHeight: 1.6,
          zIndex: 200,
          whiteSpace: content ? 'normal' : 'pre-line',
          pointerEvents: 'none',
        }}>
          {content || text}
        </div>
      )}
    </span>
  );
}

function FacetRow({ label, tooltip, tooltipContent, children }: { label: string; tooltip?: string; tooltipContent?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        minWidth: 72,
        flexShrink: 0,
      }}>
        <div style={{
          fontSize: 11,
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: '.08em',
        }}>
          {label}
        </div>
        {(tooltip || tooltipContent) && <TooltipIcon text={tooltip} content={tooltipContent} />}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        {children}
      </div>
    </div>
  );
}

/* ─── Rescan Banner ─── */
/* ─── Credential Inventory ─── */
interface CredentialRow {
  credential_type: string;
  total_exposures: number;
  active_exposures: number;
  dismissed_count: number;
  session_count: number;
  agent_count: number;
  last_seen: number;
  confirmed_exfil_count: number;
  agents: string;
}

function CredentialInventory() {
  const { t } = useTranslation();
  const { data } = useFetch<CredentialRow[]>('/api/audit/credential-inventory');
  const rows = data || [];

  if (rows.length === 0) {
    return (
      <div style={{ padding: 'var(--space-6)', color: 'var(--muted)', fontSize: 14, textAlign: 'center' }}>
        {t('audit.noCredentials')}
      </div>
    );
  }

  const totalActive = rows.reduce((s, r) => s + r.active_exposures, 0);
  const totalExfil = rows.reduce((s, r) => s + r.confirmed_exfil_count, 0);

  return (
    <div style={{ padding: 'var(--space-4) var(--space-6)' }}>
      {/* Summary bar */}
      <div style={{ display: 'flex', gap: 'var(--space-6)', marginBottom: 'var(--space-4)', fontSize: 13 }}>
        <div>
          <span style={{ color: 'var(--muted)' }}>{t('audit.credentialTypes')} </span>
          <span style={{ fontWeight: 600 }}>{rows.length}</span>
        </div>
        <div>
          <span style={{ color: 'var(--muted)' }}>{t('audit.activeExposures')} </span>
          <span style={{ fontWeight: 600, color: totalActive > 0 ? 'var(--C-amber)' : undefined }}>{totalActive}</span>
        </div>
        {totalExfil > 0 && (
          <div>
            <span style={{ color: 'var(--muted)' }}>{t('audit.confirmedExfiltrated')} </span>
            <span style={{ fontWeight: 600, color: 'var(--C-rose)' }}>{totalExfil}</span>
          </div>
        )}
      </div>

      {/* Credential table */}
      <div className="tbl" style={{ margin: 0 }}>
        <table>
          <thead>
            <tr>
              <th style={{ fontSize: 13 }}>{t('audit.credentialType')}</th>
              <th className="r" style={{ fontSize: 13 }}>{t('audit.active')}</th>
              <th className="r" style={{ fontSize: 13 }}>{t('audit.dismissed')}</th>
              <th className="r" style={{ fontSize: 13 }}>{t('audit.sessions')}</th>
              <th style={{ fontSize: 13 }}>{t('audit.agents')}</th>
              <th style={{ fontSize: 13 }}>{t('audit.lastSeen')}</th>
              <th style={{ fontSize: 13 }}>{t('audit.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.credential_type}>
                <td style={{ fontSize: 13, fontWeight: 600 }}>{t('audit.credentialTypeLabels.' + row.credential_type, { defaultValue: row.credential_type })}</td>
                <td className="r" style={{ fontSize: 13 }}>
                  <span style={{ color: row.active_exposures > 0 ? 'var(--C-amber)' : 'var(--muted)', fontWeight: 600 }}>
                    {row.active_exposures}
                  </span>
                </td>
                <td className="r" style={{ fontSize: 13, color: 'var(--muted)' }}>{row.dismissed_count}</td>
                <td className="r" style={{ fontSize: 13 }}>{row.session_count}</td>
                <td style={{ fontSize: 12, color: 'var(--muted)' }}>{row.agents}</td>
                <td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{fmtDatetime(row.last_seen)}</td>
                <td>
                  {row.confirmed_exfil_count > 0 ? (
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--C-rose)', textTransform: 'uppercase', letterSpacing: '.05em', padding: '1px 6px', border: '1px solid var(--C-rose)' }}>
                      {t('audit.exfiltrated')}
                    </span>
                  ) : row.active_exposures > 0 ? (
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--C-amber)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                      {t('audit.needsRotation')}
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('audit.allDismissed')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Audit() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'timeline' | 'risk' | 'credentials' | 'config'>('timeline');
  const { data: agents } = useFetch<string[]>('/api/audit/agents');
  const { data: facets } = useFetch<{ eventTypes: string[]; severities: string[] }>('/api/audit/facets');
  const { data: summary } = useFetch<{
    totalEvents: number;
    highRiskEvents: number;
    mediumRiskEvents: number;
    lowRiskEvents: number;
    sensitiveDataEvents: number;
    dangerousCmdEvents: number;
    injectionCount: number;
    activeFindings: number;
    dismissedFindings: number;
    agentTrust: Record<string, string>;
    agentVerdicts: Record<string, string>;
  }>('/api/audit/summary');

  const [agentFilter, setAgentFilter] = useState('');
  const [riskFilter, setRiskFilter] = useState('');
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [timeFilter, setTimeFilter] = useState<'' | 'today' | '7d' | '30d'>('');
  const agentList = agents || [];
  const eventTypeList = facets?.eventTypes || [];

  // Derive startDate/endDate from timeFilter
  const _fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const _today = new Date(); _today.setHours(0,0,0,0);
  const _addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  const startDate = timeFilter === 'today' ? _fmt(_today) : timeFilter === '7d' ? _fmt(_addDays(_today, -6)) : timeFilter === '30d' ? _fmt(_addDays(_today, -29)) : '';
  const endDate = timeFilter ? _fmt(_today) : '';

  return (
    <div style={{ paddingBottom: 120 }}>
      <PageHeader title={t('audit.title')} subtitle={<>{t('audit.subtitle')} <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.04em', color: 'var(--C-blue)', background: 'color-mix(in srgb, var(--C-blue) 12%, transparent)', padding: '1px 6px', borderRadius: 'var(--radius-full)', lineHeight: 1.4, verticalAlign: 'middle' }}>{t('nav.beta')}</span></>} />

      {/* KPI strip */}
      <KpiStrip cols={3}>
        <Kpi value={summary?.highRiskEvents || 0} label={t('audit.highRisk')} color={summary && summary.highRiskEvents > 0 ? 'var(--C-rose)' : undefined} />
        <Kpi value={summary?.mediumRiskEvents || 0} label={t('audit.mediumRisk')} color={summary && (summary.mediumRiskEvents || 0) > 0 ? 'var(--C-amber)' : undefined} />
        <Kpi value={summary?.lowRiskEvents || 0} label={t('audit.lowRisk')} color={summary && (summary.lowRiskEvents || 0) > 0 ? 'var(--C-green)' : undefined} />
      </KpiStrip>

      {/* Tabs — top of page */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 var(--space-6)', marginBottom: 0, borderBottom: '1px solid var(--border)' }}>
        <div className="tabs">
          <button className={`tab${tab === 'timeline' ? ' active' : ''}`} onClick={() => setTab('timeline')}>
            {t('audit.tabTimeline')}
          </button>
          <button className={`tab${tab === 'risk' ? ' active' : ''}`} onClick={() => setTab('risk')}>
            {t('audit.tabAgentSecurity')}
          </button>
          <button className={`tab${tab === 'credentials' ? ' active' : ''}`} onClick={() => setTab('credentials')}>
            {t('audit.tabCredentials')}
          </button>
          <button className={`tab${tab === 'config' ? ' active' : ''}`} onClick={() => setTab('config')}>
            {t('audit.tabAuditRules')}
          </button>
        </div>
      </div>

      {/* Alert banner + filters — Timeline tab only */}
      {tab === 'timeline' && (
        <>
          {/* Faceted filter chips */}
          <div style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            background: 'var(--bg)',
            padding: 'var(--space-3) var(--space-6)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}>
            <FacetRow label={t('audit.filterAgent')}>
              <Chip label={t('audit.filterAll')} active={agentFilter === ''} onClick={() => setAgentFilter('')} />
              {agentList.map(a => (
                <Chip key={a} label={a} active={agentFilter === a} onClick={() => setAgentFilter(agentFilter === a ? '' : a)} />
              ))}
            </FacetRow>
            <FacetRow label={t('audit.filterRisk')} tooltipContent={buildRiskTooltip(t)}>
              <Chip label={t('audit.filterAll')}    active={riskFilter === ''}       onClick={() => setRiskFilter('')} />
              <Chip label={t('common.high')}   active={riskFilter === 'high'}   color={RISK_COLORS.high}   onClick={() => setRiskFilter(riskFilter === 'high'   ? '' : 'high')} />
              <Chip label={t('common.medium')} active={riskFilter === 'medium'} color={RISK_COLORS.medium} onClick={() => setRiskFilter(riskFilter === 'medium' ? '' : 'medium')} />
              <Chip label={t('common.low')}    active={riskFilter === 'low'}    color={RISK_COLORS.low}    onClick={() => setRiskFilter(riskFilter === 'low'    ? '' : 'low')} />
            </FacetRow>
            {eventTypeList.length > 0 && (
              <FacetRow label={t('audit.filterEventType')} tooltipContent={buildEventTypeTooltip(t)}>
                <Chip label={t('audit.filterAll')} active={eventTypeFilter === ''} onClick={() => setEventTypeFilter('')} />
                {eventTypeList.map(et => (
                  <Chip key={et} label={t('audit.eventTypeLabels.' + et, { defaultValue: et.replace(/_/g, ' ') })} active={eventTypeFilter === et} onClick={() => setEventTypeFilter(eventTypeFilter === et ? '' : et)} />
                ))}
              </FacetRow>
            )}
            <FacetRow label={t('audit.filterTime')}>
              <Chip label={t('audit.filterAllTime')}    active={timeFilter === ''}      onClick={() => setTimeFilter('')} />
              <Chip label={t('audit.filterToday')}       active={timeFilter === 'today'} onClick={() => setTimeFilter(timeFilter === 'today' ? '' : 'today')} />
              <Chip label={t('audit.filterLast7d')} active={timeFilter === '7d'}    onClick={() => setTimeFilter(timeFilter === '7d'    ? '' : '7d')} />
              <Chip label={t('audit.filterLast30d')} active={timeFilter === '30d'} onClick={() => setTimeFilter(timeFilter === '30d'   ? '' : '30d')} />
            </FacetRow>
          </div>

          <DataAccessTimeline agentId={agentFilter} eventType={eventTypeFilter} riskLevel={riskFilter} startDate={startDate} endDate={endDate} />
        </>
      )}
      {tab === 'risk' && <AgentSecurityPanel agentId={agentFilter} agentVerdicts={summary?.agentVerdicts || {}} agentTrust={summary?.agentTrust || {}} />}
      {tab === 'credentials' && <CredentialInventory />}
      {tab === 'config' && (
        <div style={{ paddingTop: 'var(--space-4)' }}>
          <AuditRuleCard name={t('audit.sensitivePathsName')} desc={t('audit.sensitivePathsDesc')}>
            <SensitivePathRulesReadonly />
          </AuditRuleCard>
          <AuditRuleCard name={t('audit.sensitiveDataName')} desc={t('audit.sensitiveDataDesc')}>
            <SensitiveDataPatternsReadonly />
          </AuditRuleCard>
          <AuditRuleCard name={t('audit.dataExfiltrationName')} desc={t('audit.dataExfiltrationDesc')} defaultOpen={false}>
            <DataExfiltrationReadonly />
          </AuditRuleCard>
          <AuditRuleCard name={t('audit.dangerousCommandsName')} desc={t('audit.dangerousCommandsDesc')} defaultOpen={false}>
            <DangerousCommandsReadonly />
          </AuditRuleCard>
          <AuditRuleCard name={t('audit.promptInjectionName')} desc={t('audit.promptInjectionDesc')} defaultOpen={false}>
            <InjectionPatternsReadonly />
          </AuditRuleCard>
          <AuditRuleCard name={t('audit.anomalyDetectionName')} desc={t('audit.anomalyDetectionDesc')} defaultOpen={false}>
            <AnomalyDetectionReadonly />
          </AuditRuleCard>
        </div>
      )}
    </div>
  );
}
