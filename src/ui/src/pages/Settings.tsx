import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/ui';

const TOAST_AUTO_DISMISS_MS = 3_500;

// ── Toast ─────────────────────────────────────────────────────────────────────
interface Toast {
  type: 'success' | 'error';
  message: string;
}

function ToastNotice({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, TOAST_AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div style={{
      position: 'fixed',
      bottom: 'var(--space-6)',
      right: 'var(--space-6)',
      padding: 'var(--space-3) var(--space-4)',
      background: toast.type === 'success' ? 'var(--C-green)' : 'var(--C-rose)',
      color: '#fff',
      fontSize: 13,
      fontWeight: 500,
      letterSpacing: '.04em',
      zIndex: 9999,
      maxWidth: 320,
      boxShadow: '0 4px 16px rgba(0,0,0,.15)',
    }}>
      {toast.message}
    </div>
  );
}

// ── Main Settings page ────────────────────────────────────────────────────────
export default function Settings() {
  const { t } = useTranslation();
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [clawfishEnabled, setClawfishEnabled] = useState(() => localStorage.getItem('clawfish') === 'on');

  useEffect(() => {
    const sync = () => setClawfishEnabled(localStorage.getItem('clawfish') === 'on');
    window.addEventListener('clawfish-change', sync);
    return () => window.removeEventListener('clawfish-change', sync);
  }, []);

  function showToast(type: 'success' | 'error', message: string) {
    setToast({ type, message });
  }

  async function triggerReingest() {
    setRefreshing(true);
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      showToast('success', t('settings.reingestSuccess', { files: data.filesProcessed ?? 0, sessions: data.sessionsUpserted ?? 0 }));
    } catch (e) {
      showToast('error', t('settings.reingestFailed'));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div>
      {toast && <ToastNotice toast={toast} onDismiss={() => setToast(null)} />}

      <PageHeader title={t('nav.settings')} />

      {/* ── Re-ingest ── */}
      <div style={{ margin: '0 var(--space-6)' }}>
        <div className="gc" style={{ border: '1px solid rgba(239,68,68,0.3)', background: 'var(--surface)' }}>

          <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.75, maxWidth: 640, marginBottom: 'var(--space-6)' }}>
            {t('settings.reingestDesc')}
          </div>

          <div style={{
            fontSize: 13,
            color: 'var(--C-rose)',
            lineHeight: 1.75,
            maxWidth: 640,
            marginBottom: 'var(--space-4)',
            padding: 'var(--space-2) var(--space-3)',
            background: 'rgba(239,68,68,0.06)',
            border: '1px solid rgba(239,68,68,0.2)',
            borderRadius: 'var(--radius-sm)',
          }}>
            {t('settings.reingestWarning')}
          </div>

          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.75, maxWidth: 640, marginBottom: 'var(--space-4)' }}>
            {t('settings.thisWill')}
          </div>
          <ul style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.85, maxWidth: 640, margin: '0 0 var(--space-6) var(--space-4)', padding: 0, listStyle: 'disc inside' }}>
            <li>{t('settings.reingestStep1')}</li>
            <li>{t('settings.reingestStep2')}</li>
            <li>{t('settings.reingestStep3')}</li>
            <li>{t('settings.reingestStep4')}</li>
          </ul>

          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <button
              onClick={() => triggerReingest()}
              disabled={refreshing}
              style={{
                background: refreshing ? 'var(--border)' : 'var(--C-rose)',
                border: 'none',
                color: refreshing ? 'var(--muted)' : '#fff',
                padding: 'var(--space-2) var(--space-5)',
                cursor: refreshing ? 'not-allowed' : 'pointer',
                fontSize: 12,
                letterSpacing: '.1em',
                textTransform: 'uppercase',
                fontFamily: 'var(--font-b)',
                fontWeight: 600,
                borderRadius: 4,
                transition: 'all .15s',
              }}
            >
              {refreshing ? t('settings.reingesting') : t('settings.reingestButton')}
            </button>
          </div>
        </div>
      </div>

      {/* ── Cloud toggle ── */}
      <div style={{ margin: 'var(--space-6) var(--space-6) 0' }}>
        <div className="gc" style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
          <div style={{ fontSize: 14, color: 'var(--text)', fontWeight: 500, marginBottom: 'var(--space-2)' }}>
            {t('claw.title')}
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.75, maxWidth: 640, marginBottom: 'var(--space-2)' }}>
            {t('claw.desc')}
          </div>
          <ul style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.85, maxWidth: 640, margin: '0 0 var(--space-6) var(--space-4)', padding: 0, listStyle: 'disc inside' }}>
            <li><b style={{ color: 'var(--text)' }}>{t('claw.zen')}</b> — {t('claw.zenDesc')}</li>
            <li><b style={{ color: 'var(--text)' }}>{t('claw.happy')}</b> — {t('claw.happyDesc')}</li>
            <li><b style={{ color: 'var(--text)' }}>{t('claw.sleepy')}</b> — {t('claw.sleepyDesc')}</li>
          </ul>
          <button
            onClick={() => {
              const next = !clawfishEnabled;
              setClawfishEnabled(next);
              localStorage.setItem('clawfish', next ? 'on' : 'off');
              window.location.reload();
            }}
            className={`settings-toggle-btn ${clawfishEnabled ? 'enabled' : 'disabled'}`}
          >
            {clawfishEnabled ? t('claw.disable') : t('claw.enable')}
          </button>
        </div>
      </div>
    </div>
  );
}
