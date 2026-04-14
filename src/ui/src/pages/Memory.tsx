import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFetch, fmtTokens } from '../hooks';
import { FileText, Clock, HelpCircle } from 'lucide-react';
import { PageHeader, Loading, EmptyState } from '../components/ui';

function estimateTokens(content: string): string {
  const cjkCount = (content.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const ratio = content.length > 0 && cjkCount / content.length > 0.3 ? 2 : 4;
  const est = Math.ceil(content.length / ratio);
  return `~${fmtTokens(est)} tok`;
}

function TokenTooltip() {
  const { t } = useTranslation();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  function show() {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left + r.width / 2 });
  }

  return (
    <span
      ref={ref}
      style={{ display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
    >
      <HelpCircle size={9} style={{ color: 'var(--faint)', cursor: 'default' }} />
      {pos && (
        <span style={{
          position: 'fixed',
          top: pos.top,
          left: pos.left,
          transform: 'translateX(-50%)',
          marginBottom: 6,
          width: 240,
          background: 'var(--surface2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: '8px 10px',
          fontSize: 11,
          color: 'var(--text)',
          lineHeight: 1.5,
          zIndex: 9999,
          pointerEvents: 'none',
        }}>
          <strong style={{ display: 'block', marginBottom: 4 }}>{t('memory.whatDoesThisMean')}</strong>
          {t('memory.tokenTooltip1')}
          <br /><br />
          <span dangerouslySetInnerHTML={{ __html: t('memory.tokenTooltip2') }} />
        </span>
      )}
    </span>
  );
}

interface MemoryFileEntry {
  name: string;
  relPath: string;
  absPath: string;
  content: string;
  mtime: number;
  source: 'user-defined' | 'agent-generated';
}

type AgentFiles = Record<string, MemoryFileEntry[]>;

function fmtMtime(ms: number) {
  const locale = localStorage.getItem('claw-lens-lang') === 'zh' ? 'zh-CN' : 'en-US';
  const d = new Date(ms);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffH = diffMs / 3600000;
  if (diffH < 24) {
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}


export default function Memory() {
  const { t } = useTranslation();
  const { data, loading } = useFetch<AgentFiles>('/api/memory');
  const agents = Object.keys(data || {});

  const [activeAgent, setActiveAgent] = useState<string>('');
  const [selectedRelPath, setSelectedRelPath] = useState<string>('');
  const [editorContent, setEditorContent] = useState<string>('');
  const prevSelectedRef = useRef<string>('');

  // Set default agent when data loads
  useEffect(() => {
    if (agents.length > 0 && !activeAgent) {
      setActiveAgent(agents[0]);
    }
  }, [agents.join(',')]);

  // When agent changes, pick first file (or keep if still exists)
  useEffect(() => {
    if (!activeAgent || !data) return;
    const files = data[activeAgent] || [];
    if (files.length === 0) return;
    const still = files.find(f => f.relPath === selectedRelPath);
    if (!still) {
      setSelectedRelPath(files[0].relPath);
      setEditorContent(files[0].content);
    }
  }, [activeAgent]);

  // When file selection changes, load content
  function selectFile(entry: MemoryFileEntry) {
    setSelectedRelPath(entry.relPath);
    setEditorContent(entry.content);
    prevSelectedRef.current = entry.relPath;
  }

  const currentFiles = (data?.[activeAgent] || []);
  const selectedEntry = currentFiles.find(f => f.relPath === selectedRelPath);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', margin: '0 var(--space-5)' }}>
      <PageHeader title={t('memory.title')} subtitle={t('memory.subtitle', { agent: activeAgent || 'agent' })} />

      {loading && <Loading />}

      {!loading && agents.length === 0 && (
        <EmptyState>
          {t('memory.noFiles')}{' '}
          <code style={{ fontFamily: 'var(--font-m)', fontSize: 12 }}>~/.openclaw/workspace*/</code>
        </EmptyState>
      )}

      {!loading && agents.length > 0 && (
        <>
          {/* Agent tabs */}
          <div style={{
            display: 'flex',
            borderBottom: '1px solid var(--border)',
            paddingLeft: 'var(--space-5)',
            background: 'var(--surface)',
            flexShrink: 0,
          }}>
            {agents.map(agent => (
              <button
                key={agent}
                onClick={() => setActiveAgent(agent)}
                style={{
                  padding: 'var(--space-2) var(--space-4)',
                  border: 'none',
                  borderBottom: activeAgent === agent ? '2px solid var(--C-blue)' : '2px solid transparent',
                  background: 'transparent',
                  color: activeAgent === agent ? 'var(--text)' : 'var(--muted)',
                  fontFamily: 'var(--font-b)',
                  fontSize: 14,
                  fontWeight: activeAgent === agent ? 600 : 400,
                  letterSpacing: '.06em',
                  cursor: 'pointer',
                  transition: 'all .1s',
                  whiteSpace: 'nowrap',
                }}
              >
                {agent}
                <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--faint)' }}>
                  {(data?.[agent] || []).length}
                </span>
              </button>
            ))}
          </div>

          {/* Three-panel body */}
          <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
            {/* Left: file list */}
            <div style={{
              width: 220,
              flexShrink: 0,
              borderRight: '1px solid var(--border)',
              overflowY: 'auto',
              background: 'var(--surface)',
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                padding: '4px var(--space-4)',
                borderBottom: '1px solid var(--border)',
                gap: 4,
              }}>
                <span style={{ fontSize: 10, color: 'var(--faint)', fontFamily: 'var(--font-m)' }}>{t('memory.ctxCost')}</span>
                <TokenTooltip />
              </div>
              {currentFiles.length === 0 && (
                <div style={{ padding: 'var(--space-5)', color: 'var(--faint)', fontSize: 12 }}>
                  {t('memory.noFiles')}
                </div>
              )}
              {currentFiles.map(entry => {
                const isActive = entry.relPath === selectedRelPath;
                return (
                  <div
                    key={entry.relPath}
                    onClick={() => selectFile(entry)}
                    style={{
                      padding: 'var(--space-3) var(--space-4)',
                      borderBottom: '1px solid var(--border)',
                      cursor: 'pointer',
                      background: isActive ? 'var(--surface2)' : 'transparent',
                      borderLeft: isActive ? '3px solid var(--C-blue)' : '3px solid transparent',
                      transition: 'background .1s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <FileText size={11} style={{ color: isActive ? 'var(--C-blue)' : 'var(--text)', flexShrink: 0 }} />
                      <span style={{
                        fontSize: 12,
                        fontFamily: 'var(--font-b)',
                        color: 'var(--text)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {entry.name}
                      </span>
                    </div>
                    {entry.relPath !== entry.name && (
                      <div style={{ fontSize: 10, color: 'var(--faint)', fontFamily: 'var(--font-m)', marginBottom: 4, paddingLeft: 17 }}>
                        {entry.relPath}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 17 }}>
                      <span style={{ fontSize: 10, color: 'var(--faint)', display: 'flex', alignItems: 'center', gap: 3 }}>
                        <Clock size={9} />
                        {fmtMtime(entry.mtime)}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--muted)' }}>
                        {estimateTokens(entry.content)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Right: editor */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
              {!selectedEntry ? (
                <div style={{ padding: 'var(--space-8)', color: 'var(--faint)', fontSize: 13 }}>
                  {t('memory.selectFile')}
                </div>
              ) : (
                <>
                  {/* Editor header */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-2) var(--space-5)',
                    borderBottom: '1px solid var(--border)',
                    background: 'var(--surface)',
                    flexShrink: 0,
                  }}>
                    <span style={{ fontSize: 12, fontFamily: 'var(--font-b)', color: 'var(--text)' }}>
                      {selectedEntry.relPath}
                    </span>
                    <span style={{
                      fontSize: 11,
                      fontFamily: 'var(--font-m)',
                      padding: '1px 6px',
                      borderRadius: 'var(--radius-full)',
                      background: 'rgba(59,130,246,0.10)',
                      color: '#3b82f6',
                      border: '1px solid rgba(59,130,246,0.25)',
                      letterSpacing: '.01em',
                      whiteSpace: 'nowrap',
                    }} title={selectedEntry.absPath}>
                      {selectedEntry.absPath.replace(/^\/Users\/[^/]+/, '~')}
                    </span>
                  </div>

                  {/* Textarea */}
                  <textarea
                    value={editorContent}
                    readOnly
                    spellCheck={false}
                    style={{
                      flex: 1,
                      resize: 'none',
                      border: 'none',
                      outline: 'none',
                      padding: 'var(--space-5)',
                      fontFamily: 'var(--font-b)',
                      fontSize: 13,
                      lineHeight: 1.75,
                      color: 'var(--text)',
                      background: 'var(--bg)',
                      overflowY: 'auto',
                    }}
                  />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
