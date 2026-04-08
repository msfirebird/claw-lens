import { useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useFetch } from '../hooks';
import { severityColor } from '../constants/auditTypes';

/* ─── types ─── */
interface AgentStat {
  agent_id: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  tools: { tool_name: string; cnt: number }[];
  topDirs: { path: string; count: number }[];
  totalDirs: number;
  domains: { domain: string; count: number }[];
  recommendations: { severity: string; message: string; action: string }[];
}

/* ─── helpers ─── */
const verdictColor = (v: string) =>
  v === 'unsafe' ? 'var(--C-rose)' : v === 'caution' ? 'var(--C-amber)' : 'var(--C-green)';

const trustColor = (t: string) =>
  t === 'opaque' ? 'var(--C-rose)' : t === 'transparent' ? 'var(--C-amber)' : 'var(--C-green)';


const sectionLabel: CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, marginTop: 12,
};

/** Translate server-generated recommendation strings using pattern matching */
function translateRec(t: (key: string, opts?: Record<string, unknown>) => string, text: string): string {
  // "Exposed credentials N times (most common: XYZ)"
  let m = text.match(/^Exposed credentials (\d+) times \(most common: (.+)\)$/);
  if (m) return t('security.recPatterns.exposedCredentialsWithType', { count: m[1], type: m[2] });

  // "Exposed credentials N times"
  m = text.match(/^Exposed credentials (\d+) times$/);
  if (m) return t('security.recPatterns.exposedCredentials', { count: m[1] });

  // "Accessed sensitive paths N times (most frequent: XYZ)"
  m = text.match(/^Accessed sensitive paths (\d+) times \(most frequent: (.+)\)$/);
  if (m) return t('security.recPatterns.accessedSensitivePathsWithHint', { count: m[1], hint: m[2] });

  // "Accessed sensitive paths N times"
  m = text.match(/^Accessed sensitive paths (\d+) times$/);
  if (m) return t('security.recPatterns.accessedSensitivePaths', { count: m[1] });

  // "Accessed N unknown domains: ..."
  m = text.match(/^Accessed (\d+) unknown domains: (.+)$/);
  if (m) return t('security.recPatterns.accessedUnknownDomains', { count: m[1], domains: m[2] });

  // "Ran N elevated commands (sudo, ssh, curl, etc.)"
  m = text.match(/^Ran (\d+) elevated commands/);
  if (m) return t('security.recPatterns.ranElevatedCommands', { count: m[1] });

  return text;
}

function translateRecAction(t: (key: string, opts?: Record<string, unknown>) => string, text: string): string {
  const actionMap: Record<string, string> = {
    'Rotate the affected credentials and review file access.': 'security.recPatterns.rotateCredentials',
    'Add a whitelist rule in Audit Rules → Sensitive Paths, or review if expected.': 'security.recPatterns.addWhitelist',
    'Review these domains. They will be added to baseline automatically over time.': 'security.recPatterns.reviewDomains',
    'Review if these commands are necessary.': 'security.recPatterns.reviewCommands',
    'Rotate the affected credentials and review why the agent is reading these files.': 'security.recPatterns.rotateCredentialsExfil',
  };
  const key = actionMap[text];
  return key ? t(key) : text;
}

/* ─── Hover Tooltip ─── */
function HoverInfo({ children }: { children: ReactNode }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <span
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        style={{
          cursor: 'help', fontSize: 9, color: 'var(--muted)',
          border: '1px solid var(--border)', borderRadius: '50%',
          width: 13, height: 13, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}
      >?</span>
      {show && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 6,
          background: 'var(--surface2)', border: '1px solid var(--border)',
          borderRadius: 4, padding: '10px 12px', width: 320, zIndex: 200,
          pointerEvents: 'none',
        }}>
          {children}
        </div>
      )}
    </span>
  );
}

function LevelBadge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em',
      padding: '1px 6px', border: `1px solid ${color}`, color, marginRight: 6,
    }}>{label}</span>
  );
}

/* ─── Risk Count Row ─── */
function RiskCounts({ high, medium, low }: { high: number; medium: number; low: number }) {
  const { t } = useTranslation();
  const cell = (_label: string, _value: number, _color: string): CSSProperties => ({
    flex: 1, textAlign: 'center', padding: '6px 0',
  });
  return (
    <div style={{ display: 'flex', border: '1px solid var(--border)', marginBottom: 8 }}>
      <div style={cell('High', high, 'var(--C-rose)')}>
        <div style={{ fontSize: 18, fontWeight: 700, color: high > 0 ? 'var(--C-rose)' : 'var(--muted)' }}>{high}</div>
        <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{t('common.high')}</div>
      </div>
      <div style={{ ...cell('Medium', medium, 'var(--C-amber)'), borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)' }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: medium > 0 ? 'var(--C-amber)' : 'var(--muted)' }}>{medium}</div>
        <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{t('common.medium')}</div>
      </div>
      <div style={cell('Low', low, 'var(--C-green)')}>
        <div style={{ fontSize: 18, fontWeight: 700, color: low > 0 ? 'var(--C-green)' : 'var(--muted)' }}>{low}</div>
        <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{t('common.low')}</div>
      </div>
    </div>
  );
}

/* ─── Agent Card ─── */
function AgentCard({
  agent, verdict, trust,
}: {
  agent: AgentStat; verdict: string; trust: string;
}) {
  const { t } = useTranslation();
  const dirOverflow = agent.totalDirs - agent.topDirs.length;

  return (
    <div style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
      <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
        {/* Name + verdict / trust rows */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>{agent.agent_id}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 3 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--muted)', minWidth: 110 }}>
              {t('security.riskLevel')}
              <HoverInfo>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6, lineHeight: 1.5 }}>{t('security.verdictTooltipIntro')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div><LevelBadge label={t('security.verdictLabels.safe')} color="var(--C-green)" /><span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('security.verdictTooltip.safe')}</span></div>
                  <div><LevelBadge label={t('security.verdictLabels.caution')} color="var(--C-amber)" /><span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('security.verdictTooltip.caution')}</span></div>
                  <div><LevelBadge label={t('security.verdictLabels.unsafe')} color="var(--C-rose)" /><span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('security.verdictTooltip.unsafe')}</span></div>
                </div>
              </HoverInfo>
            </span>
            <span style={{ fontWeight: 600, color: verdictColor(verdict), textTransform: 'uppercase', letterSpacing: '.04em' }}>{t('security.verdictLabels.' + verdict, { defaultValue: verdict })}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--muted)', minWidth: 110 }}>
              {t('security.networkTrust')}
              <HoverInfo>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6, lineHeight: 1.5 }}>{t('security.trustTooltipIntro')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div><LevelBadge label={t('security.trustLabels.local')} color="var(--C-green)" /><span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('security.trustTooltip.local')}</span></div>
                  <div><LevelBadge label={t('security.trustLabels.transparent')} color="var(--C-amber)" /><span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('security.trustTooltip.transparent')}</span></div>
                  <div><LevelBadge label={t('security.trustLabels.opaque')} color="var(--C-rose)" /><span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('security.trustTooltip.opaque')}</span></div>
                </div>
              </HoverInfo>
            </span>
            <span style={{ fontWeight: 600, color: trustColor(trust), textTransform: 'uppercase', letterSpacing: '.04em' }}>{t('security.trustLabels.' + trust, { defaultValue: trust })}</span>
          </div>
        </div>

        {/* H / M / L risk counts */}
        <RiskCounts high={agent.highCount} medium={agent.mediumCount} low={agent.lowCount} />
      </div>

      {/* Footprint + Recommendations (always visible) */}
      <div style={{ padding: '0 var(--space-4) var(--space-3)', borderTop: '1px solid var(--border)' }}>
        {/* Tools — what tools this agent has used and how many times */}
        <div style={sectionLabel}>{t('security.toolsUsed')}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('security.toolsUsedDesc')}</div>
        {agent.tools.length > 0 ? (
          <div className="tbl" style={{ margin: 0 }}>
            <table>
              <thead><tr><th style={{ fontSize: 12 }}>{t('common.tool')}</th><th className="r" style={{ fontSize: 12 }}>{t('common.calls')}</th></tr></thead>
              <tbody>
                {agent.tools.map(tl => (
                  <tr key={tl.tool_name}>
                    <td className="mono" style={{ fontSize: 13 }}>{tl.tool_name}</td>
                    <td className="r" style={{ fontSize: 13, color: 'var(--muted)' }}>{tl.cnt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('security.noToolCalls')}</div>
        )}

        {/* Directories — where on disk this agent reads/writes */}
        <div style={sectionLabel}>{t('security.fileAccess')}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('security.fileAccessDesc')}</div>
        {agent.topDirs.length > 0 ? (
          <div className="tbl" style={{ margin: 0 }}>
            <table>
              <thead><tr><th style={{ fontSize: 12 }}>{t('common.directory')}</th><th className="r" style={{ fontSize: 12 }}>{t('common.accesses')}</th></tr></thead>
              <tbody>
                {agent.topDirs.map(d => (
                  <tr key={d.path}>
                    <td className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{d.path}</td>
                    <td className="r" style={{ fontSize: 13, color: 'var(--muted)' }}>{d.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('security.noFileAccess')}</div>
        )}
        {dirOverflow > 0 && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>+{dirOverflow} {t('security.moreDirectories')}</div>}

        {/* Domains — external services this agent has contacted */}
        <div style={sectionLabel}>{t('security.externalConnections')}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('security.externalDesc')}</div>
        {agent.domains.length > 0 ? (
          <div className="tbl" style={{ margin: 0 }}>
            <table>
              <thead><tr><th style={{ fontSize: 12 }}>{t('common.domain')}</th><th className="r" style={{ fontSize: 12 }}>{t('common.requests')}</th></tr></thead>
              <tbody>
                {agent.domains.map(d => (
                  <tr key={d.domain}>
                    <td style={{ fontSize: 13 }}>{d.domain}</td>
                    <td className="r" style={{ fontSize: 13, color: 'var(--muted)' }}>{d.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--C-green)' }}>{t('security.localOnly')}</div>
        )}

        {/* Recommendations */}
        {agent.recommendations.length > 0 && (
          <>
            <div style={sectionLabel}>{t('security.recommendations')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {agent.recommendations.map((rec, i) => (
                <div key={i} style={{ padding: '6px 10px', border: `1px solid ${severityColor(rec.severity)}`, background: 'rgba(0,0,0,0.1)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: severityColor(rec.severity) }}>{rec.severity}</span>
                    <span style={{ fontSize: 12, color: 'var(--text)' }}>{translateRec(t, rec.message)}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', paddingLeft: 'var(--space-4)' }}>{translateRecAction(t, rec.action)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

    </div>
  );
}

/* ─── Main Component ─── */
export default function AgentSecurityPanel({
  agentId,
  agentVerdicts,
  agentTrust,
}: {
  agentId?: string;
  agentVerdicts: Record<string, string>;
  agentTrust: Record<string, string>;
}) {
  const { t } = useTranslation();
  const { data: stats } = useFetch<AgentStat[]>('/api/audit/agent-stats');

  const agents = stats || [];
  const filtered = agentId ? agents.filter(a => a.agent_id === agentId) : agents;

  return (
    <div style={{ padding: 'var(--space-4) var(--space-6)' }}>
      {filtered.length === 0 && (
        <div style={{ color: 'var(--muted)', fontSize: 13, padding: 'var(--space-6) 0' }}>{t('security.noAgentData')}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 'var(--space-4)' }}>
        {filtered.map(agent => (
          <AgentCard
            key={agent.agent_id}
            agent={agent}
            verdict={agentVerdicts[agent.agent_id] || 'safe'}
            trust={agentTrust[agent.agent_id] || 'local'}
          />
        ))}
      </div>
    </div>
  );
}
