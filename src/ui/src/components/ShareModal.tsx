import { useEffect, useState } from 'react';
import { X, Download, Copy, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  dataUrl: string;
  onClose: () => void;
}

export function ShareModal({ dataUrl, onClose }: Props) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copyToClipboard() {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  }

  function downloadImage() {
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `claw-lens-${ts}.png`;
    a.click();
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999,
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          padding: 20,
          maxWidth: 'min(880px, 92vw)',
          width: '100%',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{
            fontFamily: 'var(--font-b)', fontWeight: 600, fontSize: 13,
            color: 'var(--text)', letterSpacing: '-0.01em',
          }}>
            {t('share.preview')}
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--muted)', display: 'flex', padding: 2,
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Preview */}
        <div style={{
          overflow: 'auto',
          maxHeight: 'calc(90vh - 120px)',
          border: '1px solid var(--border)',
          background: 'var(--surface2)',
        }}>
          <img
            src={dataUrl}
            style={{ display: 'block', maxWidth: '100%' }}
            alt="snapshot preview"
          />
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={copyToClipboard}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 14px',
              background: 'none',
              border: '1px solid var(--border)',
              color: 'var(--text)',
              fontFamily: 'var(--font-b)', fontSize: 13,
              cursor: 'pointer',
              transition: 'border-color .12s',
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--C-blue)')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? t('share.copied') : t('share.copy')}
          </button>
          <button
            onClick={downloadImage}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 14px',
              background: 'var(--C-blue)',
              border: '1px solid var(--C-blue)',
              color: '#fff',
              fontFamily: 'var(--font-b)', fontSize: 13,
              cursor: 'pointer',
            }}
          >
            <Download size={13} />
            {t('share.download')}
          </button>
        </div>
      </div>
    </div>
  );
}
