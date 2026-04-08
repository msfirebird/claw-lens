import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

type Mood = 'happy' | 'sleepy' | 'zen';
const MOODS: Mood[] = ['zen', 'happy', 'sleepy'];

interface MoodCfg {
  speed: number;
  bubble: string | null;
  body: string;
  bodyShade: string;
  bodyLight: string;
  label: string;
}

const SPEED_ZEN = 1.4;
const SPEED_HAPPY = 0.46;
const SPEED_SLEEPY = 0.20;

const MOOD_CFG: Record<Mood, MoodCfg> = {
  zen:    { speed: SPEED_ZEN,    bubble: '🪷',  body: '#e03520', bodyShade: '#a82010', bodyLight: '#f47060', label: 'zen'    },
  happy:  { speed: SPEED_HAPPY,  bubble: '😊', body: '#3a9060', bodyShade: '#206040', bodyLight: '#70c890', label: 'happy'  },
  sleepy: { speed: SPEED_SLEEPY, bubble: '💤', body: '#c05070', bodyShade: '#883050', bodyLight: '#e090a8', label: 'sleepy' },
};

const W = 88;
const H = 88;
const HOVER_SPEED = 0.22;
const BUBBLE_LIFETIME_MS = 2200;
const BUBBLE_EMIT_INTERVAL_MS = 1400;

// ── Green shrimp (青虾) for zen mode ─────────────────────────────────────────
function ShrimpSvg() {
  const body    = '#3a9060';
  const shade   = '#1e6040';
  const light   = '#70c890';
  const transl  = 'rgba(80,180,120,0.18)';

  return (
    <svg viewBox="0 0 88 88" width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
      {/* Shadow */}
      <ellipse cx="44" cy="86" rx="20" ry="3.5" fill="rgba(0,0,0,0.13)" />

      {/* ── Long antennae ── */}
      <path d="M 36 22 Q 28 12 18 2"  stroke={shade} strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <path d="M 40 20 Q 34 10 28 1"  stroke={shade} strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <path d="M 50 22 Q 56 14 62 6"  stroke={shade} strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <path d="M 47 21 Q 52 12 56 4"  stroke={shade} strokeWidth="1.4" fill="none" strokeLinecap="round" />

      {/* ── Small front claws ── */}
      {/* left claw arm */}
      <path d="M 28 48 Q 18 42 14 36" stroke={body} strokeWidth="5" fill="none" strokeLinecap="round" />
      <circle cx="13" cy="34" r="5" fill={body} />
      <path d="M 17 31 Q 10 28 8 22"  stroke={body} strokeWidth="4" fill="none" strokeLinecap="round" />
      <path d="M 17 37 Q 10 37 8 43"  stroke={body} strokeWidth="4" fill="none" strokeLinecap="round" />
      <path d="M 16 33 Q 10 33 9 38"  stroke={shade} strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.5" />
      {/* right claw arm */}
      <path d="M 60 48 Q 70 42 74 36" stroke={body} strokeWidth="5" fill="none" strokeLinecap="round" />
      <circle cx="75" cy="34" r="5" fill={body} />
      <path d="M 71 31 Q 78 28 80 22"  stroke={body} strokeWidth="4" fill="none" strokeLinecap="round" />
      <path d="M 71 37 Q 78 37 80 43"  stroke={body} strokeWidth="4" fill="none" strokeLinecap="round" />
      <path d="M 72 33 Q 78 33 79 38"  stroke={shade} strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.5" />

      {/* ── Walking legs (5 pairs, thin) ── */}
      {[32, 38, 44, 50, 56].map((x, i) => (
        <g key={i}>
          <path d={`M ${x} 70 Q ${x-4} 78 ${x-3} 84`} stroke={shade} strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d={`M ${x+3} 70 Q ${x+7} 78 ${x+6} 84`} stroke={shade} strokeWidth="2" fill="none" strokeLinecap="round" />
        </g>
      ))}

      {/* ── Curved segmented body ── */}
      {/* Tail fan */}
      <path d="M 28 76 Q 22 84 16 86" stroke={shade} strokeWidth="5" fill="none" strokeLinecap="round" />
      <path d="M 34 78 Q 30 86 26 88" stroke={body}  strokeWidth="5" fill="none" strokeLinecap="round" />
      <path d="M 44 79 Q 44 88 44 88" stroke={body}  strokeWidth="6" fill="none" strokeLinecap="round" />
      <path d="M 54 78 Q 58 86 62 88" stroke={body}  strokeWidth="5" fill="none" strokeLinecap="round" />
      <path d="M 60 76 Q 66 84 72 86" stroke={shade} strokeWidth="5" fill="none" strokeLinecap="round" />

      {/* Abdomen segments (curved arching back) */}
      <ellipse cx="44" cy="70" rx="18" ry="8"  fill={body}  />
      <ellipse cx="44" cy="70" rx="14" ry="5.5" fill={light} opacity="0.18" />
      <path d="M 29 68 Q 44 62 59 68" stroke={shade} strokeWidth="1.2" fill="none" opacity="0.35" />
      <path d="M 30 72 Q 44 66 58 72" stroke={shade} strokeWidth="1.2" fill="none" opacity="0.3" />

      {/* Carapace (main shell) */}
      <ellipse cx="44" cy="52" rx="22" ry="20" fill={body} />
      <ellipse cx="44" cy="45" rx="16" ry="10" fill={transl} />
      <ellipse cx="38" cy="38" rx="9"  ry="5"  fill="rgba(255,255,255,0.12)" />

      {/* Rostrum (horn) */}
      <path d="M 38 26 Q 32 16 24 8" stroke={shade} strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M 40 25 Q 35 16 30 9"  stroke={body}  strokeWidth="2" fill="none" strokeLinecap="round" />

      {/* ── Eyes on stalks ── */}
      <path d="M 32 34 Q 28 30 26 28" stroke={shade} strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <circle cx="25" cy="27" r="5" fill="#111" />
      <circle cx="23" cy="25" r="1.6" fill="white" opacity="0.8" />

      <path d="M 52 34 Q 56 30 59 28" stroke={shade} strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <circle cx="60" cy="27" r="5" fill="#111" />
      <circle cx="58" cy="25" r="1.6" fill="white" opacity="0.8" />

      {/* Zen calm expression */}
      <path d="M 37 48 Q 44 52 51 48" stroke={shade} strokeWidth="1.8" fill="none" strokeLinecap="round" opacity="0.5" />

      {/* Translucent belly shine */}
      <ellipse cx="44" cy="58" rx="12" ry="7" fill="rgba(180,255,210,0.10)" />

      {/* Forehead dots */}
      <circle cx="38" cy="32" r="1.8" fill="#a0ffcc" opacity="0.8" />
      <circle cx="44" cy="29" r="2.2" fill="#a0ffcc" opacity="0.95" />
      <circle cx="50" cy="32" r="1.8" fill="#a0ffcc" opacity="0.8" />
    </svg>
  );
}

// ── Lobster for zen (red) and sleepy (pink) ───────────────────────────────────
function LobsterSvg({ cfg, mood }: { cfg: MoodCfg; mood: Mood }) {
  const { body, bodyShade, bodyLight } = cfg;
  const sleepy = mood === 'sleepy';

  // Zen: claws raised high; sleepy: claws drooped low
  const armLY = sleepy ? 62 : 34;
  const armRY = sleepy ? 64 : 32;
  const armLX = sleepy ? 20 : 16;
  const armRX = sleepy ? 68 : 72;

  return (
    <svg viewBox="0 0 88 88" width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>

      {/* Shadow */}
      <ellipse cx="44" cy="86" rx="24" ry="4" fill="rgba(0,0,0,0.16)" />

      {/* ── Antennae ── */}
      {sleepy ? <>
        <path d="M 30 20 Q 24 30 20 36" stroke={bodyShade} strokeWidth="2.5" fill="none" strokeLinecap="round" />
        <path d="M 36 18 Q 32 28 30 34" stroke={bodyShade} strokeWidth="2.5" fill="none" strokeLinecap="round" />
      </> : <>
        <path d="M 30 20 Q 22 10 16 4"  stroke={bodyShade} strokeWidth="2.5" fill="none" strokeLinecap="round" />
        <path d="M 36 18 Q 30 8  24 2"  stroke={bodyShade} strokeWidth="2.5" fill="none" strokeLinecap="round" />
      </>}
      {/* antenna tips */}
      <circle cx={sleepy ? 19 : 15} cy={sleepy ? 37 : 3}  r="2" fill={bodyShade} />
      <circle cx={sleepy ? 29 : 23} cy={sleepy ? 35 : 1}  r="2" fill={bodyShade} />

      {/* ── Left arm + claw ── */}
      <path d={`M 26 52 Q ${armLX+4} ${armLY+8} ${armLX+2} ${armLY+2}`}
        stroke={body} strokeWidth="7" fill="none" strokeLinecap="round" />
      <circle cx={armLX+1} cy={armLY} r="7" fill={body} />
      <path d={`M ${armLX+6} ${armLY-4} Q ${armLX-4} ${armLY-8} ${armLX-6} ${armLY-16}`}
        stroke={body} strokeWidth="6" fill="none" strokeLinecap="round" />
      <path d={`M ${armLX+6} ${armLY+4} Q ${armLX-2} ${armLY+8} ${armLX-5} ${armLY+16}`}
        stroke={body} strokeWidth="6" fill="none" strokeLinecap="round" />
      <path d={`M ${armLX+4} ${armLY-1} Q ${armLX-3} ${armLY} ${armLX-2} ${armLY+6}`}
        stroke={bodyShade} strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.5" />

      {/* ── Right arm + claw ── */}
      <path d={`M 62 52 Q ${armRX-4} ${armRY+8} ${armRX-2} ${armRY+2}`}
        stroke={body} strokeWidth="7" fill="none" strokeLinecap="round" />
      <circle cx={armRX-1} cy={armRY} r="7" fill={body} />
      <path d={`M ${armRX-6} ${armRY-4} Q ${armRX+4} ${armRY-8} ${armRX+6} ${armRY-16}`}
        stroke={body} strokeWidth="6" fill="none" strokeLinecap="round" />
      <path d={`M ${armRX-6} ${armRY+4} Q ${armRX+2} ${armRY+8} ${armRX+5} ${armRY+16}`}
        stroke={body} strokeWidth="6" fill="none" strokeLinecap="round" />
      <path d={`M ${armRX-4} ${armRY-1} Q ${armRX+3} ${armRY} ${armRX+2} ${armRY+6}`}
        stroke={bodyShade} strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.5" />

      {/* ── Little legs (3 pairs, short stubs) ── */}
      {[34, 44, 54].map((x, i) => (
        <g key={i}>
          <path d={`M ${x} 71 Q ${x-5} 79 ${x-4} ${83+(sleepy?3:0)}`}
            stroke={bodyShade} strokeWidth="2.8" fill="none" strokeLinecap="round" />
          <path d={`M ${x+4} 71 Q ${x+9} 79 ${x+8} ${83+(sleepy?3:0)}`}
            stroke={bodyShade} strokeWidth="2.8" fill="none" strokeLinecap="round" />
        </g>
      ))}

      {/* ── Main body — big circle ── */}
      <circle cx="44" cy="52" r="32" fill={body} />
      <ellipse cx="44" cy="65" rx="18" ry="10" fill={bodyLight} opacity="0.20" />
      <ellipse cx="36" cy="36" rx="12" ry="7" fill="rgba(255,255,255,0.16)" />

      {/* ── Eyes ── */}
      <circle cx="30" cy="40" r="6" fill="#111" />
      {sleepy
        ? <>
            {/* Drooping eyelid — filled body-color shape covers top half of eye */}
            <path d="M 24 40 Q 30 35 36 40" fill={body} />
            <circle cx="29" cy="42" r="1.4" fill="white" opacity="0.6" />
          </>
        : <>
            <circle cx="30" cy="40" r="5.5" fill="#111" />
            <circle cx="28" cy="38" r="1.8" fill="white" opacity="0.85" />
          </>
      }

      <circle cx="58" cy="40" r="6" fill="#111" />
      {sleepy
        ? <>
            <path d="M 52 40 Q 58 35 64 40" fill={body} />
            <circle cx="57" cy="42" r="1.4" fill="white" opacity="0.6" />
          </>
        : <>
            <circle cx="58" cy="40" r="5.5" fill="#111" />
            <circle cx="56" cy="38" r="1.8" fill="white" opacity="0.85" />
          </>
      }

      {/* Mouth */}
      {sleepy
        ? <path d="M 39 53 Q 44 54 49 53" stroke={bodyShade} strokeWidth="1.8" fill="none" strokeLinecap="round" opacity="0.45" />
        : <path d="M 39 53 Q 44 56 49 53" stroke={bodyShade} strokeWidth="1.8" fill="none" strokeLinecap="round" opacity="0.4" />
      }
    </svg>
  );
}

interface FloatBubble { id: number; emoji: string; x: number; y: number; }

export default function ClawFish() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(() =>
    localStorage.getItem('clawfish') === 'on'
  );
  const [moodIdx, setMoodIdx] = useState(() => {
    const saved = parseInt(localStorage.getItem('clawfish-mood') ?? '0');
    return isNaN(saved) ? 0 : saved % MOODS.length;
  });
  const [hovered, setHovered] = useState(false);
  const [bubble, setBubble]   = useState<{ emoji: string; x: number; y: number } | null>(null);
  const [hoverBubbles, setHoverBubbles] = useState<FloatBubble[]>([]);

  const elRef      = useRef<HTMLDivElement>(null);
  const xRef       = useRef(160);
  const yRef       = useRef(0);
  const dirRef     = useRef(1);
  const tRef       = useRef(0);
  const rafRef     = useRef(0);
  const speedRef   = useRef(MOOD_CFG[MOODS[moodIdx]].speed);
  const hoveredRef = useRef(false);
  const bubbleIdRef = useRef(0);
  const moodRef    = useRef<Mood>('happy');

  const mood = MOODS[moodIdx];
  const cfg  = MOOD_CFG[mood];

  useEffect(() => { speedRef.current = cfg.speed; }, [cfg.speed]);
  useEffect(() => { hoveredRef.current = hovered; }, [hovered]);
  useEffect(() => { moodRef.current = mood; }, [mood]);

  // Continuously emit bubbles while hovered
  useEffect(() => {
    if (!hovered || !cfg.bubble) return;
    const emit = () => {
      const id = ++bubbleIdRef.current;
      const jitter = (Math.random() - 0.5) * 24;
      setHoverBubbles(prev => [...prev, {
        id,
        emoji: cfg.bubble!,
        x: xRef.current + W / 2 + jitter,
        y: yRef.current + H / 4,
      }]);
      setTimeout(() => setHoverBubbles(prev => prev.filter(b => b.id !== id)), BUBBLE_LIFETIME_MS);
    };
    emit();
    const iv = setInterval(emit, BUBBLE_EMIT_INTERVAL_MS);
    return () => clearInterval(iv);
  }, [hovered, cfg.bubble]);

  const tick = useCallback(() => {
    tRef.current += 0.016;
    const factor = hoveredRef.current ? HOVER_SPEED : 1;
    xRef.current += dirRef.current * speedRef.current * factor;

    const winW  = window.innerWidth;
    const baseY = window.innerHeight * 0.80;
    const m     = moodRef.current;

    let dy = 0;
    let rot = 0;

    if (m === 'happy') {
      // Green shrimp: big fast crawling bob — two overlaid frequencies
      const t = tRef.current;
      dy  = Math.sin(t * 3.2) * 26 + Math.sin(t * 6.5) * 8;
      // Tilt follows the vertical velocity (cos of primary wave)
      rot = Math.cos(t * 3.2) * 14 * dirRef.current;
    } else if (m === 'sleepy') {
      // Barely drifting, very gentle
      dy = Math.sin(tRef.current * 0.55) * 7;
    } else {
      // Zen red lobster: smooth standard swim
      dy = Math.sin(tRef.current * 1.1) * 14;
    }

    yRef.current = baseY + dy;

    const maxX = winW - W - 24;
    if (xRef.current >= maxX)    { xRef.current = maxX; dirRef.current = -1; }
    else if (xRef.current <= 16) { xRef.current = 16;   dirRef.current =  1; }

    if (elRef.current) {
      elRef.current.style.transform =
        `translate(${xRef.current}px, ${yRef.current}px) scaleX(${dirRef.current}) rotate(${rot}deg)`;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    yRef.current = window.innerHeight * 0.80;
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [enabled, tick]);

  const cycleMood = () => {
    const next    = (moodIdx + 1) % MOODS.length;
    const nextCfg = MOOD_CFG[MOODS[next]];
    setMoodIdx(next);
    localStorage.setItem('clawfish-mood', String(next));
    if (nextCfg.bubble) {
      setBubble({ emoji: nextCfg.bubble, x: xRef.current + W / 2, y: yRef.current });
      setTimeout(() => setBubble(null), 2400);
    }
  };

  const hideFish = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEnabled(false);
    localStorage.setItem('clawfish', 'off');
    window.dispatchEvent(new CustomEvent('clawfish-change'));
  };

  if (!enabled) return null;

  return (
    <>
      <style>{`
        @keyframes clawfish-rise {
          0%   { opacity: 1; transform: translateY(0) scale(1); }
          70%  { opacity: 0.85; }
          100% { opacity: 0; transform: translateY(-48px) scale(1.2); }
        }
      `}</style>

      <div
        ref={elRef}
        onClick={cycleMood}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={t('clawfish.tooltipTitle', { mood: t('claw.' + cfg.label) })}
        style={{
          position: 'fixed', top: 0, left: 0,
          width: W, height: H,
          zIndex: 9990,
          cursor: 'pointer',
          userSelect: 'none',
          willChange: 'transform',
        }}
      >
        {mood === 'happy' ? <ShrimpSvg /> : <LobsterSvg cfg={cfg} mood={mood} />}

        {hovered && (
          <div
            onClick={hideFish}
            title={t('clawfish.hide')}
            style={{
              position: 'absolute', top: -10, right: -10,
              width: 26, height: 26, borderRadius: '50%',
              background: 'rgba(15,15,15,0.80)',
              border: '1.5px solid rgba(255,255,255,0.22)',
              color: 'rgba(255,255,255,0.95)',
              fontSize: 16, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              lineHeight: 1,
              boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
              transition: 'background .12s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(200,35,15,0.88)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(15,15,15,0.80)')}
          >
            ×
          </div>
        )}
      </div>

      {bubble && (
        <div
          key={bubble.emoji + bubble.x}
          style={{
            position: 'fixed',
            left: bubble.x - 14,
            top:  bubble.y - 36,
            fontSize: 22,
            pointerEvents: 'none',
            zIndex: 9991,
            animation: 'clawfish-rise 2.4s ease-out forwards',
          }}
        >
          {bubble.emoji}
        </div>
      )}

      {hoverBubbles.map(b => (
        <div
          key={b.id}
          style={{
            position: 'fixed',
            left: b.x - 11,
            top:  b.y - 20,
            fontSize: 18,
            pointerEvents: 'none',
            zIndex: 9991,
            animation: 'clawfish-rise 2.2s ease-out forwards',
            opacity: 0.88,
          }}
        >
          {b.emoji}
        </div>
      ))}
    </>
  );
}
