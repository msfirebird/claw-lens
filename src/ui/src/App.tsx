import { Routes, Route, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  BarChart2, List, Activity, Cpu, Timer,
  CalendarClock, Gauge, ShieldAlert, BookOpen, RefreshCw,
  Settings, Users,
  PlayCircle, Zap, Repeat2, Globe,
} from 'lucide-react';
import { useState } from 'react';
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

      </nav>

      {/* ── Main ── */}
      <main className="main" style={{ display: 'flex', flexDirection: 'column' }}>
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
    <ClawFish />
    </>
  );
}
