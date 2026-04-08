import { Routes, Route, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  BarChart2, List, Activity, Cpu, Timer,
  CalendarClock, Gauge, ShieldAlert, BookOpen, RefreshCw,
  Settings, Users,
  PlayCircle, Zap, Repeat2, Globe, Share2,
} from 'lucide-react';
import { useState, useRef } from 'react';
import { toPng } from 'html-to-image';
import { ShareModal } from './components/ShareModal';
import { useTranslation } from 'react-i18next';
import { useHumanInLoopNotifier } from './hooks';
import Overview from './pages/Overview';
import Sessions from './pages/Sessions';
import LiveMonitor from './pages/LiveMonitor';
import Profiler from './pages/Profiler';
import Cron from './pages/Cron';
import Audit from './pages/Audit';
import Memory from './pages/Memory';
import Agents from './pages/Agents';
// AgentGraph is now embedded in Agents page
import SettingsPage from './pages/Settings';
import SessionTimeline from './pages/SessionTimeline';
import DebugReplay from './pages/DebugReplay';
import DebugContext from './pages/DebugContext';
import AgentLoops from './pages/AgentLoops';
import TokenUsage from './pages/TokenUsage';
import ClawFish from './components/ClawFish';

const routeConfig: { path: string; element: React.ReactNode }[] = [
  { path: '/',                  element: <Overview /> },
  { path: '/tokens',            element: <TokenUsage /> },
  { path: '/agents',            element: <Agents /> },
  { path: '/sessions',          element: <Sessions /> },
  { path: '/live',              element: <LiveMonitor /> },
  { path: '/profiler',          element: <Profiler /> },
  { path: '/cron',              element: <Cron /> },
  { path: '/audit',             element: <Audit /> },
  { path: '/memory',            element: <Memory /> },
  { path: '/timeline',          element: <SessionTimeline /> },
  { path: '/cachetrace',        element: <DebugReplay /> },
  { path: '/contextbreakdown',  element: <DebugContext /> },
  { path: '/deepturn',          element: <AgentLoops /> },
  { path: '/settings',          element: <SettingsPage /> },
];

/** Returns "/zh" when current language is Chinese, "" otherwise */
function useLangPrefix(): string {
  const { i18n } = useTranslation();
  return i18n.language === 'zh' ? '/zh' : '';
}

/** Strip /zh prefix from pathname for route matching */
function stripZh(pathname: string): string {
  if (pathname === '/zh') return '/';
  if (pathname.startsWith('/zh/')) return pathname.slice(3);
  return pathname;
}

interface NavItem {
  to: string;
  labelKey: string;
  icon: React.ElementType;
  badgeKey?: string;
}

interface NavGroup {
  labelKey: string;
  items: NavItem[];
  badge?: { text: string; color: string; bg: string };
}

const navGroups: NavGroup[] = [
  {
    labelKey: 'nav.monitor',
    items: [
      { to: '/',          labelKey: 'nav.overview',     icon: BarChart2 },
      { to: '/tokens',    labelKey: 'nav.tokens',       icon: Zap },
      { to: '/agents',    labelKey: 'nav.agents',       icon: Users },
      { to: '/live',      labelKey: 'nav.live',         icon: Activity },
      { to: '/sessions',  labelKey: 'nav.sessions',     icon: List },
      { to: '/cron',      labelKey: 'nav.cron',         icon: CalendarClock },
      { to: '/memory',    labelKey: 'nav.memory',       icon: BookOpen },
      { to: '/audit',     labelKey: 'nav.audit',        icon: ShieldAlert, badgeKey: 'nav.beta' },
    ],
  },
  {
    labelKey: 'nav.devtools',
    items: [
      { to: '/timeline',             labelKey: 'nav.sessionTimeline', icon: Timer },
      { to: '/profiler',             labelKey: 'nav.profiler',         icon: Gauge },
      { to: '/deepturn',          labelKey: 'nav.deepTurns',     icon: Repeat2 },
      { to: '/contextbreakdown',     labelKey: 'nav.contextBreakdown', icon: Cpu },
      { to: '/cachetrace',           labelKey: 'nav.cacheTrace',    icon: PlayCircle },
    ],
  },
  {
    labelKey: 'nav.system',
    items: [
      { to: '/settings', labelKey: 'nav.settings',     icon: Settings },
    ],
  },
];

// All top-level routes that belong to a group (for active-group detection)
const allRoutes = navGroups.flatMap(g => g.items.map(i => ({ ...i, group: g.labelKey })));

function SidebarGroup({
  group,
  defaultOpen = true,
}: {
  group: NavGroup;
  defaultOpen?: boolean;
}) {
  const location = useLocation();
  const { t } = useTranslation();
  const prefix = useLangPrefix();
  const bare = stripZh(location.pathname);
  const hasActive = group.items.some(item =>
    item.to === '/' ? bare === '/' : bare.startsWith(item.to)
  );
  const [open, setOpen] = useState(defaultOpen || hasActive);

  return (
    <div style={{ marginBottom: 'var(--space-1)' }}>
      {/* Category header — Vercel style */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-1)',
          padding: 'var(--space-4) var(--space-4) var(--space-1)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--muted)',
          fontSize: 12,
          fontFamily: 'var(--font-b)',
          fontWeight: 400,
          letterSpacing: '.05em',
          textTransform: 'uppercase',
          textAlign: 'left',
          transition: 'color .12s',
          lineHeight: 1.4,
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--muted)'; }}
      >
        <span>{t(group.labelKey)}</span>
        {group.badge && (
          <span style={{
            fontSize: 9, fontWeight: 500, letterSpacing: '.04em',
            color: group.badge.color, background: group.badge.bg,
            padding: '1px 5px', borderRadius: 'var(--radius-full)',
            lineHeight: 1.4,
          }}>{group.badge.text}</span>
        )}
        <span style={{
          display: 'inline-block', flexShrink: 0,
          width: 0, height: 0,
          borderStyle: 'solid',
          opacity: 0.6,
          ...(open
            ? { borderWidth: '5px 4px 0 4px', borderColor: 'currentColor transparent transparent transparent', marginTop: 1 }
            : { borderWidth: '4px 0 4px 6px', borderColor: 'transparent transparent transparent currentColor' }
          ),
        }} />
      </button>

      {/* Items */}
      {open && (
        <div>
          {group.items.map(({ to, labelKey, icon: Icon, badgeKey }) => (
            <NavLink
              key={to}
              to={prefix + to}
              end={to === '/'}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                padding: 'var(--space-2) var(--space-4)',
                margin: '0 var(--space-2)',
                fontSize: 14,
                fontWeight: isActive ? 500 : 400,
                fontFamily: 'var(--font-b)',
                color: isActive ? 'var(--text)' : 'var(--muted)',
                textDecoration: 'none',
                borderRadius: 'var(--radius-sm)',
                background: isActive ? 'var(--surface3)' : 'transparent',
                transition: 'color .12s, background .12s',
                letterSpacing: '0',
                lineHeight: 1.5,
              })}
              onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLAnchorElement;
                if (bare !== to) {
                  el.style.color = 'var(--text)';
                  el.style.background = 'var(--surface2)';
                }
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLAnchorElement;
                const isActive = to === '/' ? bare === '/' : bare.startsWith(to);
                el.style.color = isActive ? 'var(--text)' : 'var(--muted)';
                el.style.background = isActive ? 'var(--surface3)' : 'transparent';
              }}
            >
              {({ isActive }) => (
                <>
                  <Icon size={14} style={{ opacity: isActive ? 1 : 0.5, flexShrink: 0 }} />
                  {t(labelKey)}
                  {badgeKey && (
                    <span style={{
                      fontSize: 10, fontWeight: 500, letterSpacing: '.04em',
                      color: 'var(--C-blue)', background: 'color-mix(in srgb, var(--C-blue) 12%, transparent)',
                      padding: '1px 5px', borderRadius: 'var(--radius-full)',
                      lineHeight: 1.4,
                    }}>{t(badgeKey)}</span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [refreshing, setRefreshing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareHovered, setShareHovered] = useState(false);
  const [shareDataUrl, setShareDataUrl] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const { t, i18n } = useTranslation();
  useHumanInLoopNotifier();
  void allRoutes; // used for type-checking

  function toggleLanguage() {
    const next = i18n.language === 'zh' ? 'en' : 'zh';
    i18n.changeLanguage(next);
    localStorage.setItem('claw-lens-lang', next);
    const bare = stripZh(location.pathname);
    navigate(next === 'zh' ? '/zh' + bare : bare);
  }

  async function triggerReingest() {
    setRefreshing(true);
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      if (res.ok) navigate(0);
    } catch { /* network error */ } finally {
      setRefreshing(false);
    }
  }

  const WATERMARK_FONT_SIZE_RATIO = 0.012;
  const WATERMARK_BG = 'rgba(12, 8, 6, 0.68)';
  const WATERMARK_ICON_COLOR = '#f472b6';

  async function captureShareSnapshot() {
    if (!mainRef.current || sharing) return;
    setSharing(true);
    try {
      const dataUrl = await toPng(mainRef.current, { pixelRatio: 2, cacheBust: true, skipFonts: true });

      const img = new window.Image();
      img.src = dataUrl;
      await new Promise<void>(resolve => { img.onload = () => resolve(); });

      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);

      // Date formatted per language
      const now = new Date();
      const isZh = i18n.language === 'zh';
      const dateStr = isZh
        ? `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
        : now.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const label = `Claw Lens · ${dateStr}`;

      const fontSize = Math.max(14, Math.round(img.width * WATERMARK_FONT_SIZE_RATIO));
      ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;

      // Icon dimensions
      const iconR = fontSize * 0.38;       // magnifier circle radius
      const iconW = fontSize * 1.15;       // total icon width slot

      const tw = ctx.measureText(label).width;
      const ph = fontSize * 2.0;
      const pw = iconW + tw + fontSize * 1.8;
      const margin = fontSize * 1.1;
      const px = img.width - pw - margin;
      const py = img.height - ph - margin;
      const pillR = ph / 2;

      // Pill background
      ctx.fillStyle = WATERMARK_BG;
      ctx.beginPath();
      ctx.roundRect(px, py, pw, ph, pillR);
      ctx.fill();

      // Pink magnifying glass icon
      const cx = px + fontSize * 0.95;
      const cy = py + ph / 2 - fontSize * 0.05;
      ctx.strokeStyle = WATERMARK_ICON_COLOR;
      ctx.lineWidth = Math.max(1.5, fontSize * 0.11);
      ctx.lineCap = 'round';
      // Circle
      ctx.beginPath();
      ctx.arc(cx, cy, iconR, 0, Math.PI * 2);
      ctx.stroke();
      // Handle
      const handleAngle = Math.PI * 0.25; // 45° — handle points lower-right
      const hx1 = cx + iconR * Math.cos(handleAngle);
      const hy1 = cy + iconR * Math.sin(handleAngle);
      ctx.beginPath();
      ctx.moveTo(hx1, hy1);
      ctx.lineTo(hx1 + iconR * 0.7 * Math.cos(handleAngle), hy1 + iconR * 0.7 * Math.sin(handleAngle));
      ctx.stroke();

      // Label text
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, px + iconW + fontSize * 0.6, py + ph / 2);

      setShareDataUrl(canvas.toDataURL('image/png'));
    } catch (err) {
      console.error('Share failed:', err);
    } finally {
      setSharing(false);
    }
  }

  return (
    <>
    <div className="layout">
      {/* ── Sidebar ── */}
      <nav style={{
        width: 220,
        flexShrink: 0,
        background: 'var(--sidebar)',
        display: 'flex',
        flexDirection: 'column',
        position: 'sticky',
        top: 0,
        height: '100vh',
        borderRight: '1px solid var(--border)',
        overflowY: 'auto',
      }}>
        {/* Logo */}
        <div style={{
          padding: 'var(--space-5) var(--space-4) var(--space-4)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{
              fontFamily: 'var(--font-b)',
              fontSize: 18,
              fontWeight: 700,
              color: '#fff',
              letterSpacing: '-0.02em',
            }}>
              {t('app.title')}
            </span>
            <button
              onClick={triggerReingest}
              disabled={refreshing}
              title={t('common.refreshData')}
              style={{
                background: 'none',
                border: '1px solid var(--border)',
                color: 'var(--muted)',
                padding: 'var(--space-1)',
                borderRadius: 'var(--radius-sm)',
                cursor: refreshing ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'color .12s, border-color .12s',
                opacity: refreshing ? 0.5 : 1,
              }}
              onMouseEnter={(e) => { if (!refreshing) { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.2)'; } }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--muted)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; }}
            >
              <RefreshCw size={13} style={{ animation: refreshing ? 'spin 1s linear infinite' : 'none' }} />
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'var(--space-1)' }}>
            <span style={{
              fontSize: 9,
              fontWeight: 500,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: '#ef4444',
              background: 'rgba(239, 68, 68, 0.12)',
              padding: '1px 6px',
              borderRadius: 'var(--radius-full)',
            }}>
              {t('app.tagline')}
            </span>
            <button
              onClick={toggleLanguage}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '1px 6px',
                background: 'none',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-full)',
                color: 'var(--muted)',
                fontSize: 9,
                fontWeight: 500,
                letterSpacing: '.04em',
                cursor: 'pointer',
                transition: 'border-color .12s, color .12s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--C-blue)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--muted)'; }}
            >
              <Globe size={10} style={{ opacity: 0.5 }} />
              <span style={{
                fontWeight: i18n.language === 'en' ? 700 : 400,
                color: i18n.language === 'en' ? '#fff' : 'var(--muted)',
              }}>{t('lang.en')}</span>
              <span style={{ opacity: 0.3 }}>|</span>
              <span style={{
                fontWeight: i18n.language === 'zh' ? 700 : 400,
                color: i18n.language === 'zh' ? '#fff' : 'var(--muted)',
              }}>{t('lang.zh')}</span>
            </button>
          </div>
        </div>

        {/* Nav groups */}
        <div style={{ padding: '.75rem 0', flex: 1 }}>
          {navGroups.map(group => (
            <SidebarGroup key={group.labelKey} group={group} defaultOpen={true} />
          ))}
        </div>

        {/* Sidebar footer — Share button */}
        <div style={{
          padding: 'var(--space-3) var(--space-3) var(--space-5)',
          borderTop: '1px solid var(--border)',
          flexShrink: 0,
          position: 'relative',
        }}
          onMouseEnter={() => setShareHovered(true)}
          onMouseLeave={() => setShareHovered(false)}
        >
          {/* Tooltip */}
          {shareHovered && !sharing && (
            <div style={{
              position: 'absolute',
              bottom: 'calc(100% - var(--space-2))',
              left: 'var(--space-3)',
              right: 'var(--space-3)',
              background: 'rgba(10,7,5,0.96)',
              border: '1px solid rgba(99,153,255,0.25)',
              borderRadius: 'var(--radius-sm)',
              padding: '8px 10px',
              pointerEvents: 'none',
              zIndex: 100,
            }}>
              <p style={{ margin: 0, fontSize: 11, lineHeight: 1.55, color: 'rgba(255,255,255,0.85)', fontFamily: 'var(--font-b)' }}>
                {t('share.tooltip')}
              </p>
              {/* Arrow */}
              <div style={{
                position: 'absolute',
                bottom: -5,
                left: '50%',
                transform: 'translateX(-50%) rotate(45deg)',
                width: 8, height: 8,
                background: 'rgba(10,7,5,0.96)',
                border: '1px solid rgba(99,153,255,0.25)',
                borderTop: 'none', borderLeft: 'none',
              }} />
            </div>
          )}
          <button
            onClick={captureShareSnapshot}
            disabled={sharing}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 'var(--space-2)',
              padding: 'var(--space-2) var(--space-3)',
              background: sharing ? 'rgba(99,153,255,0.08)' : 'rgba(99,153,255,0.10)',
              border: '1px solid rgba(99,153,255,0.35)',
              borderRadius: 'var(--radius-sm)',
              color: sharing ? 'var(--muted)' : 'rgba(180,210,255,0.92)',
              fontFamily: 'var(--font-b)',
              fontSize: 12,
              cursor: sharing ? 'not-allowed' : 'pointer',
              transition: 'color .12s, border-color .12s, background .12s',
              opacity: sharing ? 0.6 : 1,
            }}
            onMouseEnter={e => { if (!sharing) { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(99,153,255,0.18)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(99,153,255,0.65)'; (e.currentTarget as HTMLButtonElement).style.color = '#fff'; } }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(99,153,255,0.10)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(99,153,255,0.35)'; (e.currentTarget as HTMLButtonElement).style.color = 'rgba(180,210,255,0.92)'; }}
          >
            <Share2 size={12} style={{ flexShrink: 0 }} />
            {sharing ? t('share.capturing') : t('share.snapshot')}
          </button>
        </div>

      </nav>

      {/* ── Main ── */}
      <main ref={mainRef} className="main" style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflow: 'auto' }}>
        <Routes>
          {['', '/zh'].map(prefix =>
            routeConfig.map(r => (
              <Route key={prefix + r.path} path={prefix + r.path} element={r.element} />
            ))
          )}
        </Routes>
        </div>
      </main>
    </div>
    {shareDataUrl && (
      <ShareModal dataUrl={shareDataUrl} onClose={() => setShareDataUrl(null)} />
    )}
    <ClawFish />
    </>
  );
}
