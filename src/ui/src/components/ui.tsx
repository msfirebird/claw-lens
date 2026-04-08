/**
 * Shared UI primitives — every page should use these instead of
 * defining its own inline styles for common patterns.
 *
 * Design system: see .claude/skills/ui-design-spec.md
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

/* ------------------------------------------------------------------ */
/*  PageHeader                                                         */
/* ------------------------------------------------------------------ */
export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="ph">
      <h1 className="ph-title">{title}</h1>
      {(subtitle || children) && (
        <div className="ph-meta" style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          {subtitle && <span>{subtitle}</span>}
          {children}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SectionLabel  —  "RECENT SESSIONS", "TOOL STATS", etc.            */
/* ------------------------------------------------------------------ */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="sl">
      <span className="sl-t">{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  KpiStrip  +  Kpi                                                   */
/* ------------------------------------------------------------------ */
export function KpiStrip({
  cols: _cols,
  children,
  style,
}: {
  cols?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className="kpis"
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(115px, 100%), 1fr))`, ...style }}
    >
      {children}
    </div>
  );
}

export function Kpi({
  value,
  label,
  sub,
  color,
  highlight,
  tooltip,
  valueFontSize,
}: {
  value: React.ReactNode;
  label: React.ReactNode;
  sub?: React.ReactNode;
  color?: string;
  highlight?: boolean;
  tooltip?: string;
  valueFontSize?: number;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className={`kpi${highlight ? ' hi' : ''}`}
      style={{ position: 'relative' }}
      onMouseEnter={() => tooltip && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="kv" style={{ color, fontVariantNumeric: 'tabular-nums', ...(valueFontSize ? { fontSize: valueFontSize } : {}) }}>
        {value}
      </div>
      <div className="kl" style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        {label}
        {tooltip && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 14, height: 14, borderRadius: '50%',
            border: '1px solid var(--muted)', color: 'var(--muted)',
            fontSize: 9, fontFamily: 'var(--font-b)', fontWeight: 600,
            lineHeight: 1, cursor: 'default', flexShrink: 0,
          }}>?</span>
        )}
      </div>
      {sub && <div className="ks">{sub}</div>}
      {tooltip && hovered && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', left: '50%',
          transform: 'translateX(-50%)',
          background: 'var(--surface3, #1e1e2e)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '8px 12px',
          fontSize: 12, lineHeight: 1.55,
          color: 'var(--text)',
          whiteSpace: 'pre-line',
          width: 220,
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          zIndex: 100,
          pointerEvents: 'none',
        }}>
          {tooltip}
          {/* arrow pointing up */}
          <span style={{
            position: 'absolute', top: -5, left: '50%',
            transform: 'translateX(-50%) rotate(45deg)',
            width: 8, height: 8,
            background: 'var(--surface3, #1e1e2e)',
            borderLeft: '1px solid var(--border)',
            borderTop: '1px solid var(--border)',
          }} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AlertBanner  —  colored bar with dot                               */
/* ------------------------------------------------------------------ */
export function AlertBanner({
  children,
  variant = 'warning',
}: {
  children: React.ReactNode;
  variant?: 'warning' | 'error' | 'info';
}) {
  const color =
    variant === 'error' ? 'var(--C-rose)' :
    variant === 'info' ? 'var(--C-blue)' :
    'var(--C-amber)';
  return (
    <div className="alert">
      <div className="adot" style={{ background: color }} />
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  UnavailableBanner  —  amber warning for missing debug features     */
/* ------------------------------------------------------------------ */
export function UnavailableBanner({
  feature,
  flag = 'OPENCLAW_ANTHROPIC_PAYLOAD_LOG=1',
}: {
  feature: string;
  flag?: string;
}) {
  const { t } = useTranslation();
  return (
    <div style={{
      border: '1px solid var(--C-amber)',
      borderRadius: 'var(--radius)',
      padding: 'var(--space-4) var(--space-5)',
      background: 'rgba(217,119,6,0.08)',
      color: 'var(--C-amber)',
      fontSize: 14,
      marginBottom: 'var(--space-6)',
    }}>
      <strong>{t('ui.debugUnavailable')}</strong> — {feature} {t('ui.requiresPayloadLogging')}{' '}
      <code style={{ fontFamily: 'var(--font-m)', fontSize: 13 }}>{flag}</code>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Badge                                                              */
/* ------------------------------------------------------------------ */
const BADGE_COLORS = {
  blue:    { color: 'var(--C-blue)',  bg: 'rgba(59,130,246,0.15)' },
  green:   { color: 'var(--C-green)', bg: 'rgba(34,197,94,0.15)' },
  amber:   { color: 'var(--C-amber)', bg: 'rgba(234,179,8,0.15)' },
  red:     { color: 'var(--C-rose)',  bg: 'rgba(239,68,68,0.15)' },
  purple:  { color: 'var(--C-purple)', bg: 'rgba(168,85,247,0.15)' },
  neutral: { color: 'var(--muted)',   bg: 'var(--surface2)' },
} as const;

export function Badge({
  children,
  variant = 'neutral',
}: {
  children: React.ReactNode;
  variant?: keyof typeof BADGE_COLORS;
}) {
  const c = BADGE_COLORS[variant];
  return (
    <span style={{
      fontSize: 12,
      fontWeight: 500,
      padding: '2px 8px',
      borderRadius: 'var(--radius-full)',
      color: c.color,
      background: c.bg,
      fontFamily: 'var(--font-b)',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  StatusDot  —  colored dot with optional glow animation             */
/* ------------------------------------------------------------------ */
export function StatusDot({
  color,
  glow,
  size = 6,
}: {
  color: string;
  glow?: boolean;
  size?: number;
}) {
  return (
    <span style={{
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: '50%',
      background: color,
      flexShrink: 0,
      boxShadow: glow ? `0 0 6px ${color}` : 'none',
      animation: glow ? 'pulse 2s ease-in-out infinite' : 'none',
    }} />
  );
}

/* ------------------------------------------------------------------ */
/*  Dropdown  —  styled <select> with border, radius, arrow           */
/* ------------------------------------------------------------------ */
export function Dropdown<T extends string | number>({
  value,
  onChange,
  options,
  style,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { label: string; value: T }[];
  style?: React.CSSProperties;
}) {
  return (
    <select
      value={String(value)}
      onChange={e => {
        const raw = e.target.value;
        const parsed = typeof value === 'number' ? Number(raw) as T : raw as T;
        onChange(parsed);
      }}
      style={{
        padding: '6px 30px 6px 12px',
        fontSize: 13,
        fontFamily: 'var(--font-b)',
        color: 'var(--text)',
        background: 'var(--surface)',
        border: '1px solid var(--border2)',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        appearance: 'none',
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23a1a1a1' fill='none' stroke-width='1.5'/%3E%3C/svg%3E")`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 10px center',
        outline: 'none',
        ...style,
      }}
    >
      {options.map(o => (
        <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
      ))}
    </select>
  );
}

/* ------------------------------------------------------------------ */
/*  EmptyState                                                         */
/* ------------------------------------------------------------------ */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: 'var(--space-8) var(--space-4)',
      textAlign: 'center',
      color: 'var(--muted)',
      fontSize: 14,
    }}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Loading                                                            */
/* ------------------------------------------------------------------ */
export function Loading({ text }: { text?: string }) {
  const { t } = useTranslation();
  const displayText = text ?? t('common.loading');
  return (
    <div style={{
      padding: 'var(--space-5)',
      color: 'var(--muted)',
      fontSize: 14,
    }}>
      {displayText}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Card  —  bordered container                                        */
/* ------------------------------------------------------------------ */
export function Card({
  children,
  style,
  onClick,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  onClick?: () => void;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--surface)',
        borderRadius: 'var(--radius)',
        padding: 'var(--space-4)',
        cursor: onClick ? 'pointer' : undefined,
        ...style,
      }}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ProgressBar                                                        */
/* ------------------------------------------------------------------ */
export function ProgressBar({
  value,
  max = 1,
  color,
  width = 80,
  height = 6,
  showLabel,
}: {
  value: number;
  max?: number;
  color?: string;
  width?: number | string;
  height?: number;
  showLabel?: boolean;
}) {
  const pct = Math.min(100, (value / max) * 100);
  const barColor = color ?? (
    pct >= 50 ? 'var(--C-green)' : pct >= 20 ? 'var(--C-amber)' : 'var(--C-rose)'
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <div style={{
        width,
        height,
        background: 'var(--surface2)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${pct}%`,
          height: '100%',
          background: barColor,
          borderRadius: 'var(--radius-sm)',
          transition: 'width .3s',
        }} />
      </div>
      {showLabel && (
        <span style={{ fontSize: 12, color: barColor, fontVariantNumeric: 'tabular-nums' }}>
          {pct.toFixed(1)}%
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  InfoTooltip  —  hover to reveal explanatory text                   */
/* ------------------------------------------------------------------ */
export function InfoTooltip({
  label,
  children,
  placement = 'bottom',
  align = 'left',
  width = 300,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  placement?: 'top' | 'bottom';
  align?: 'left' | 'right';
  width?: number;
}) {
  const [show, setShow] = useState(false);
  const posStyle = {
    ...(placement === 'bottom' ? { top: 'calc(100% + 6px)' } : { bottom: 'calc(100% + 6px)' }),
    ...(align === 'right' ? { right: 0 } : { left: 0 }),
  };
  return (
    <span
      style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <span style={{
        cursor: 'help',
        color: 'var(--muted)',
        fontSize: 12,
        whiteSpace: 'nowrap',
        borderBottom: '1px dashed var(--muted)',
        paddingBottom: 1,
      }}>
        {label}
      </span>
      {show && (
        <div style={{
          position: 'absolute',
          ...posStyle,
          padding: 'var(--space-3) var(--space-4)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          fontSize: 12,
          color: 'var(--text)',
          lineHeight: 1.55,
          width,
          zIndex: 200,
          whiteSpace: 'normal',
          boxShadow: '0 4px 16px rgba(0,0,0,.45)',
          pointerEvents: 'none',
        }}>
          {children}
        </div>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  TabBar  —  button group for switching views                        */
/* ------------------------------------------------------------------ */
export function TabBar<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: T; label: string }[];
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="tabs">
      {tabs.map(t => (
        <button
          key={t.key}
          className={`tab${active === t.key ? ' on' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  DateNavigator — reusable date picker for day/hour/week modes       */
/* ------------------------------------------------------------------ */

const _addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const _toDateStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const _WD_EN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const _WD_ZH = ['日','一','二','三','四','五','六'];
const _fmtShort = (d: Date, lang: string) => lang === 'zh'
  ? `周${_WD_ZH[d.getDay()]} ${d.getMonth()+1}/${d.getDate()}`
  : `${_WD_EN[d.getDay()]} ${d.getMonth()+1}/${d.getDate()}`;

interface DateNavDayProps {
  mode: 'day';
  /** End date of the 7-day window */
  value: Date;
  onChange: (d: Date) => void;
}
interface DateNavHourProps {
  mode: 'hour';
  /** The single day to show */
  value: Date;
  onChange: (d: Date) => void;
}
interface DateNavWeekProps {
  mode: 'week';
  value?: undefined;
  onChange?: undefined;
}

type DateNavigatorProps = DateNavDayProps | DateNavHourProps | DateNavWeekProps;

export function DateNavigator(props: DateNavigatorProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [calOpen, setCalOpen] = useState(false);
  const today = new Date(); today.setHours(0,0,0,0);
  const earliest = _addDays(today, -90);

  const arrowStyle = (enabled: boolean): React.CSSProperties => ({
    background: 'none', border: '1px solid var(--border2)', borderRadius: 'var(--radius-sm)',
    cursor: enabled ? 'pointer' : 'default',
    color: enabled ? 'var(--muted)' : 'var(--surface3)',
    fontSize: 14, padding: '4px 8px', lineHeight: 1,
    opacity: enabled ? 1 : 0.3,
  });

  if (props.mode === 'week') {
    return (
      <span style={{ fontSize: 13, color: 'var(--muted)', padding: '6px 12px', border: '1px solid var(--border2)', borderRadius: 'var(--radius-sm)', opacity: 0.6 }}>
        {t('common.last90days')}
      </span>
    );
  }

  if (props.mode === 'day') {
    const { value, onChange } = props;
    const canBack = _addDays(value, -7) >= earliest;
    const canFwd = _addDays(value, 1) <= today;
    const goBack = () => { if (canBack) onChange(_addDays(value, -7)); };
    const goFwd = () => { if (canFwd) { const n = _addDays(value, 7); onChange(n <= today ? n : today); } };
    const label = `${_fmtShort(_addDays(value, -6), lang)} – ${_fmtShort(value, lang)}`;

    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
        <button onClick={goBack} disabled={!canBack} style={arrowStyle(canBack)}>◀</button>
        <div style={{ position: 'relative' }}>
          <button onClick={() => setCalOpen(!calOpen)} style={{
            background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 'var(--radius-sm)',
            color: 'var(--text)', fontSize: 13, fontWeight: 500, padding: '6px 12px',
            cursor: 'pointer', fontVariantNumeric: 'tabular-nums', minWidth: 180, textAlign: 'center',
          }}>
            {label} ▾
          </button>
          {calOpen && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 100,
              background: 'rgba(26, 26, 26, 0.97)', backdropFilter: 'blur(8px)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)',
              padding: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.7)', maxHeight: 300, overflowY: 'auto', width: 240,
            }}>
              {Array.from({ length: 13 }, (_, w) => {
                const end = _addDays(today, -w * 7);
                const start = _addDays(end, -6);
                const isSelected = _toDateStr(end) === _toDateStr(value);
                return (
                  <button key={w} onClick={() => { onChange(end); setCalOpen(false); }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '8px 12px', fontSize: 13, fontVariantNumeric: 'tabular-nums',
                      border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                      background: isSelected ? 'rgba(59,130,246,0.15)' : 'transparent',
                      color: isSelected ? 'var(--C-blue)' : 'var(--text)',
                    }}
                  >{_fmtShort(start, lang)} – {_fmtShort(end, lang)}</button>
                );
              })}
            </div>
          )}
        </div>
        <button onClick={goFwd} disabled={!canFwd} style={arrowStyle(canFwd)}>▶</button>
      </div>
    );
  }

  // Hour mode
  const { value, onChange } = props;
  const canBack = _addDays(value, -1) >= earliest;
  const canFwd = _addDays(value, 1) <= today;
  const goBack = () => { if (canBack) onChange(_addDays(value, -1)); };
  const goFwd = () => { if (canFwd) onChange(_addDays(value, 1)); };
  const calLocale = lang === 'zh' ? 'zh-CN' : 'en';
  const wdHeaders = lang === 'zh' ? ['日','一','二','三','四','五','六'] : ['S','M','T','W','T','F','S'];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
      <button onClick={goBack} disabled={!canBack} style={arrowStyle(canBack)}>◀</button>
      <div style={{ position: 'relative' }}>
        <button onClick={() => setCalOpen(!calOpen)} style={{
          background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 'var(--radius-sm)',
          color: 'var(--text)', fontSize: 13, fontWeight: 500, padding: '6px 12px',
          cursor: 'pointer', fontVariantNumeric: 'tabular-nums', minWidth: 180, textAlign: 'center',
        }}>
          {_fmtShort(value, lang)} ▾
        </button>
        {calOpen && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 100,
            background: 'rgba(26, 26, 26, 0.97)', backdropFilter: 'blur(8px)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            padding: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.7)', width: 280,
          }}>
            {[0, 1, 2].map(monthOffset => {
              const refDate = new Date(today.getFullYear(), today.getMonth() - monthOffset, 1);
              const monthName = refDate.toLocaleString(calLocale, { month: 'short', year: 'numeric' });
              const daysInMonth = new Date(refDate.getFullYear(), refDate.getMonth() + 1, 0).getDate();
              const firstDow = refDate.getDay();
              const cells: (number | null)[] = [];
              for (let i = 0; i < firstDow; i++) cells.push(null);
              for (let d = 1; d <= daysInMonth; d++) cells.push(d);
              return (
                <div key={monthOffset} style={{ marginBottom: monthOffset < 2 ? 12 : 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>{monthName}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, fontSize: 11 }}>
                    {wdHeaders.map((wd, i) => (
                      <div key={i} style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 10, padding: 2 }}>{wd}</div>
                    ))}
                    {cells.map((day, i) => {
                      if (day === null) return <div key={`e${i}`} />;
                      const d = new Date(refDate.getFullYear(), refDate.getMonth(), day);
                      const ds = _toDateStr(d);
                      const isFuture = d > today;
                      const isSelected = ds === _toDateStr(value);
                      return (
                        <button key={ds} disabled={isFuture}
                          onClick={() => { onChange(d); setCalOpen(false); }}
                          style={{
                            padding: 4, textAlign: 'center', fontSize: 11, lineHeight: 1,
                            border: isSelected ? '1px solid var(--C-blue)' : '1px solid transparent',
                            borderRadius: 'var(--radius-sm)', cursor: isFuture ? 'default' : 'pointer',
                            background: isSelected ? 'rgba(59,130,246,0.2)' : 'transparent',
                            color: isFuture ? 'var(--surface3)' : isSelected ? 'var(--C-blue)' : 'var(--text)',
                          }}
                        >{day}</button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <button onClick={goFwd} disabled={!canFwd} style={arrowStyle(canFwd)}>▶</button>
    </div>
  );
}
