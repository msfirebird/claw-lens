import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { diffLines } from 'diff';

interface DiffViewProps {
  oldText: string;
  newText: string;
  /** Max consecutive unchanged lines before collapsing */
  collapseThreshold?: number;
}

interface DiffBlock {
  type: 'added' | 'removed' | 'unchanged' | 'collapsed';
  lines: string[];
  count: number;
}

export function DiffView({ oldText, newText, collapseThreshold = 3 }: DiffViewProps) {
  const { t } = useTranslation();
  const blocks = useMemo(() => {
    const changes = diffLines(oldText, newText);
    const raw: DiffBlock[] = [];

    for (const change of changes) {
      const lines = (change.value.endsWith('\n') ? change.value.slice(0, -1) : change.value).split('\n');
      if (change.added) {
        raw.push({ type: 'added', lines, count: lines.length });
      } else if (change.removed) {
        raw.push({ type: 'removed', lines, count: lines.length });
      } else {
        // Collapse long unchanged sections
        if (lines.length > collapseThreshold) {
          // Show first line, collapse middle, show last line
          raw.push({ type: 'unchanged', lines: [lines[0]], count: 1 });
          raw.push({ type: 'collapsed', lines: lines.slice(1, -1), count: lines.length - 2 });
          raw.push({ type: 'unchanged', lines: [lines[lines.length - 1]], count: 1 });
        } else {
          raw.push({ type: 'unchanged', lines, count: lines.length });
        }
      }
    }
    return raw;
  }, [oldText, newText, collapseThreshold]);

  const [expandedCollapsed, setExpandedCollapsed] = useState<Set<number>>(new Set());

  return (
    <div style={{ fontFamily: 'var(--font-m)', fontSize: 12, lineHeight: 1.6, overflowX: 'auto' }}>
      {blocks.map((block, bi) => {
        if (block.type === 'collapsed') {
          if (expandedCollapsed.has(bi)) {
            // Render the stored collapsed lines
            return (
              <div key={bi}>
                {block.lines.map((line, li) => (
                  <div key={li} style={{ padding: '0 8px', whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{line || '\u00A0'}</div>
                ))}
              </div>
            );
          }
          return (
            <button
              key={bi}
              onClick={() => setExpandedCollapsed(s => new Set(s).add(bi))}
              style={{
                display: 'block', width: '100%', padding: '3px 8px',
                background: 'rgba(255,255,255,0.03)', border: 'none', borderTop: '1px solid rgba(255,255,255,0.06)', borderBottom: '1px solid rgba(255,255,255,0.06)',
                color: 'var(--muted)', fontSize: 11, cursor: 'pointer', textAlign: 'center',
              }}
            >
              … {block.count} {t('common.linesUnchanged')} …
            </button>
          );
        }

        const bg = block.type === 'added'
          ? 'rgba(16,185,129,0.12)'
          : block.type === 'removed'
            ? 'rgba(239,68,68,0.12)'
            : 'transparent';
        const prefix = block.type === 'added' ? '+' : block.type === 'removed' ? '-' : ' ';
        const color = block.type === 'added' ? '#10B981' : block.type === 'removed' ? '#EF4444' : 'var(--text)';

        return block.lines.map((line, li) => (
          <div key={`${bi}-${li}`} style={{ background: bg, padding: '0 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            <span style={{ color: 'var(--muted)', opacity: 0.5, userSelect: 'none', display: 'inline-block', width: 14 }}>{prefix}</span>
            <span style={{ color }}>{line}</span>
          </div>
        ));
      })}
    </div>
  );
}
