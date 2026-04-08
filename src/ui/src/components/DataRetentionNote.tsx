import { useTranslation } from 'react-i18next';

export default function DataRetentionNote() {
  const { t } = useTranslation();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#888' }}>
      {t('retention.pruneNote')}
      <span style={{ position: 'relative', display: 'inline-block' }} className="prune-tip-wrap">
        <span style={{ fontSize: 11, color: 'var(--muted)', borderBottom: '1px dashed var(--muted)', cursor: 'default', whiteSpace: 'nowrap' }}>{t('retention.howToChange')}</span>
        <span className="prune-tip-box" style={{
          display: 'none', position: 'absolute', top: '1.5rem', left: 0,
          width: 420, background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', padding: '.65rem .8rem',
          fontSize: 11, lineHeight: 1.55, color: 'var(--text)',
          boxShadow: '0 4px 16px rgba(0,0,0,.3)', zIndex: 100,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('retention.configIn')}</div>
          <pre style={{ margin: '6px 0', padding: 8, background: 'var(--bg-1)', borderRadius: 4, fontSize: 11, overflowX: 'auto' }}>{`{
  "session": {
    "maintenance": {
      "pruneAfter": "90d",
      "resetArchiveRetention": "90d"
    }
  }
}`}</pre>
          <strong>pruneAfter</strong> — {t('retention.pruneAfterDesc')}<br/>
          <strong>resetArchiveRetention</strong> — {t('retention.resetArchiveDesc')}<br/>
          {t('retention.acceptedValues')} <code>"30d"</code>, <code>"720h"</code>, or <code>false</code> {t('retention.neverPrune')}<br/>
          {t('retention.restartGateway')}
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
            <strong>{t('retention.fileLifecycle')}</strong> {t('retention.filesNotDeleted')}<br/>
            <strong>.deleted</strong> — {t('retention.deletedDesc')} <code>.jsonl</code> {t('retention.to')} <code>.jsonl.deleted.{'<timestamp>'}</code>.<br/>
            <strong>.reset</strong> — {t('retention.resetDesc')} <code>.jsonl.reset.{'<timestamp>'}</code> {t('retention.andFresh')} <code>.jsonl</code> {t('retention.isCreated')}<br/>
            {t('retention.bothSuffixed')} <code>pruneAfterMs</code> / <code>resetArchiveRetentionMs</code> {t('retention.expires')}
          </div>
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', color: 'var(--muted)', fontStyle: 'italic' }}>
            {t('retention.askOpenClaw')}
          </div>
        </span>
        <style>{`.prune-tip-wrap:hover .prune-tip-box { display: block !important; }`}</style>
      </span>
    </span>
  );
}
