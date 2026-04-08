import { useTranslation } from 'react-i18next';
import { fmtTokens } from '../hooks';
import type { PromptSectionEstimate } from '../utils/estimateSections';

const COLORS: Record<string, string> = {
  Base: 'var(--C-blue)',
  Tooling: '#0891B2',
  Workspace: 'var(--C-amber)',
  Memory: 'var(--C-green)',
};

export function TokenBar({ sections }: { sections: PromptSectionEstimate[] }) {
  const { t } = useTranslation();
  const total = sections.reduce((a, s) => a + s.tokens, 0);
  if (total === 0 || sections.length === 0) return null;

  return (
    <div>
      <div style={{ display: 'flex', height: 8, borderRadius: 'var(--radius-sm)', overflow: 'hidden', gap: 1, marginBottom: 'var(--space-2)' }}>
        {sections.map(s => (
          <div
            key={s.label}
            style={{ flex: s.tokens / total, background: COLORS[s.label] ?? 'var(--muted)', minWidth: s.tokens > 0 ? 2 : 0 }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {sections.map(s => (
          <div key={s.label} style={{ fontSize: 12, lineHeight: 1.5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[s.label] ?? 'var(--muted)', display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }} />
            <span style={{ color: 'var(--text)' }}>{t(`tokenBar.${s.label.toLowerCase()}`, s.label)}: </span>
            <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(s.tokens)}</span>
            <span style={{ color: 'var(--muted)', marginLeft: 6 }}>({t(`tokenBar.${s.label.toLowerCase()}Hint`, s.hint)})</span>
          </div>
        ))}
        <div style={{ fontSize: 11, color: 'var(--muted)', opacity: 0.6, marginTop: 2 }}>
          {t('tokenBar.estimateNote')}
        </div>
      </div>
    </div>
  );
}
