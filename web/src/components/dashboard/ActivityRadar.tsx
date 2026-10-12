import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Chat, ChatState } from '@/lib/types';
import { chatProject, relativeTime } from '@/lib/chat-groups';
import { states } from './StateBadge';
import { ToolLogo } from './ToolLogo';

// A time dial. Angle = time since the chat's last activity: "now" at 12 o'clock,
// older clockwise on a log scale (the last minutes get room, days compress).
// Ring = state: what waits for you sits closest to the centre.
// The grid is SVG in a 500-unit box; markers are HTML on top so their size and
// numbers stay legible at any radar width.
const VIEW = 500;
const C = VIEW / 2;
const DIAL = 196;
const CORE = 42;
const RING: Record<ChatState, number> = { waiting: 84, working: 124, cut: 160, unknown: 160, closed: 184 };
const TAU = 5 * 60_000;
const SPAN = 0.92;
const MARKER_PX = 26;
const TICKS = [
  { ms: 0, label: 'Now' },
  { ms: 10 * 60_000, label: '10 min' },
  { ms: 3_600_000, label: '1 h' },
  { ms: 6 * 3_600_000, label: '6 h' },
  { ms: 86_400_000, label: '1 d' },
  { ms: 3 * 86_400_000, label: '3 d' },
  { ms: 7 * 86_400_000, label: '7 d' },
];

const angleOf = (age: number, windowMs: number) =>
  Math.min(1, Math.log1p(Math.max(0, age) / TAU) / Math.log1p(windowMs / TAU)) * SPAN * 2 * Math.PI;
const at = (r: number, a: number) => ({ x: C + r * Math.sin(a), y: C - r * Math.cos(a) });
const pct = (v: number) => `${(v / VIEW) * 100}%`;

// Static dial markings, built once.
const DIAL_TICKS = Array.from({ length: 72 }, (_, i) => {
  const a = (i / 72) * 2 * Math.PI;
  const inner = at(DIAL - (i % 6 === 0 ? 10 : 5), a);
  const outer = at(DIAL, a);
  return <line key={i} className={i % 6 === 0 ? 'major-tick' : 'minor-tick'} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} />;
});
const GRID = <>
  <defs>
    <radialGradient id="radar-core"><stop offset="0" stopColor="var(--raised)" /><stop offset="1" stopColor="var(--inset)" /></radialGradient>
  </defs>
  {[RING.waiting, RING.working, RING.cut, RING.closed].map(r => <circle key={r} className="ring" cx={C} cy={C} r={r} />)}
  <circle className="dial" cx={C} cy={C} r={DIAL} />
  {DIAL_TICKS}
  <line className="now-line" x1={C} y1={C - CORE} x2={C} y2={C - DIAL} />
  <circle className="core" cx={C} cy={C} r={CORE} />
  {/* You, at the centre: everything waiting for you is closest. */}
  <circle className="core-ring" cx={C} cy={C} r={CORE * 0.55} />
  <circle className="core-dot" cx={C} cy={C} r={9} />
</>;

type Marker = { chat: Chat; x: number; y: number; px: number; number?: number };

// Places each chat on its ring. Neighbours closer than their on-screen size are
// nudged clockwise so markers never cover each other at the current radar width.
function layout(chats: Chat[], now: number, windowMs: number, numbers: Map<string, number>, unitsPerPx: number): Marker[] {
  const rings = new Map<number, { chat: Chat; a: number; px: number }[]>();
  for (const chat of chats) {
    const r = RING[chat.state];
    const px = MARKER_PX;
    const list = rings.get(r) ?? [];
    list.push({ chat, a: angleOf(now - chat.lastActivity, windowMs), px });
    rings.set(r, list);
  }
  const markers: Marker[] = [];
  for (const [r, list] of rings) {
    list.sort((p, q) => p.a - q.a);
    const gapOf = (px: number, prevPx: number) => (((px + prevPx) / 2 + 3) * unitsPerPx) / r;
    const needed = list.reduce((sum, n) => sum + gapOf(n.px, n.px), 0);
    const squeeze = Math.min(1, (2 * Math.PI * 0.97) / needed);
    let last = -Infinity;
    let lastPx = 0;
    for (const n of list) {
      const a = Math.max(n.a, last + gapOf(n.px, lastPx) * squeeze);
      last = a;
      lastPx = n.px;
      markers.push({ chat: n.chat, ...at(r, a), px: n.px, number: numbers.get(n.chat.id) });
    }
  }
  // Closed dots first so live markers paint on top.
  return markers.sort((p, q) => Number(q.chat.state === 'closed') - Number(p.chat.state === 'closed'));
}

function tickSide(a: number) {
  const s = Math.sin(a);
  if (s > 0.35) return 'start';
  if (s < -0.35) return 'end';
  return Math.cos(a) > 0 ? 'top' : 'bottom';
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

type RadarProps = {
  chats: Chat[];
  now: number;
  windowDays: number;
  numbers: Map<string, number>;
  paused: boolean;
  onSelect: (id: string) => void;
};

export const ActivityRadar = memo(function ActivityRadar({ chats, now, windowDays, numbers, paused, onSelect }: RadarProps) {
  const windowMs = windowDays * 86_400_000;
  const [stageRef, width] = useWidth<HTMLDivElement>();
  const unitsPerPx = width ? VIEW / width : 1.4;
  const markers = useMemo(() => layout(chats, now, windowMs, numbers, unitsPerPx), [chats, now, windowMs, numbers, unitsPerPx]);
  const ticks = useMemo(() => TICKS.filter(t => t.ms <= windowMs).map(t => {
    const a = angleOf(t.ms, windowMs);
    return { ...t, a, ...at(DIAL, a), from: at(CORE + 8, a), to: at(DIAL, a) };
  }), [windowMs]);
  const [active, setActive] = useState<string | null>(null);
  const activeMarker = markers.find(marker => marker.chat.id === active);

  return <div className={`circular-radar ${paused ? 'is-paused' : ''}`}>
    <div className="radar-stage" ref={stageRef}>
      <div className="circle-sweep" aria-hidden="true" />
      <svg className="radar-svg" viewBox={`0 0 ${VIEW} ${VIEW}`} aria-hidden="true">
        {GRID}
        {ticks.slice(1).map(t => <line key={t.ms} className="spoke" x1={t.from.x} y1={t.from.y} x2={t.to.x} y2={t.to.y} />)}
      </svg>
      {ticks.map(t => <span key={t.ms} className={`radar-tick ${t.ms === 0 ? 'is-now' : ''}`} data-side={tickSide(t.a)} style={{ left: pct(t.x), top: pct(t.y) }} aria-hidden="true">{t.label}</span>)}
      <div className="radar-markers" role="group" aria-label="Chats on the radar">
        {markers.map(marker => {
          const { chat } = marker;
          const toolName = chat.tool === 'claude' ? 'Claude' : 'Codex';
          return <button key={chat.id} type="button"
            data-chat-id={chat.id} className={`marker state-${chat.state} tool-${chat.tool} ${chat.role === 'orchestrator' ? 'orchestrator-marker' : ''} ${marker.number !== undefined ? 'is-numbered' : ''}`}
            style={{ left: pct(marker.x), top: pct(marker.y), '--size': `${marker.px}px` } as CSSProperties}
            aria-label={`${marker.number !== undefined ? `${marker.number}. ` : ''}${chat.title}: ${states[chat.state].label}, ${toolName}, ${relativeTime(chat.lastActivity, now)}`}
            onClick={() => onSelect(chat.id)}
            onMouseEnter={() => setActive(chat.id)} onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(chat.id)} onBlur={() => setActive(null)}>
            <ToolLogo tool={chat.tool} size={marker.px} state={chat.state} />
            {marker.number !== undefined && <span className="marker-number" aria-hidden="true">{marker.number}</span>}
          </button>;
        })}
      </div>
      {activeMarker && <div className="radar-tooltip" role="presentation"
        data-below={activeMarker.y < VIEW * 0.32 ? '' : undefined}
        style={{ left: Math.max(8, Math.min(width - Math.min(270,width-16) - 8, activeMarker.x / unitsPerPx - Math.min(270,width-16)/2)), top: pct(activeMarker.y) }}>
        <strong>{activeMarker.chat.title}</strong>
        <span>{states[activeMarker.chat.state].label} · {activeMarker.chat.tool === 'claude' ? 'Claude' : 'Codex'} · {relativeTime(activeMarker.chat.lastActivity, now)}</span>
        <span className="tooltip-path">{chatProject(activeMarker.chat) || 'Environment'}</span>
      </div>}
      {!chats.length && <p className="radar-empty">No activity recorded</p>}
    </div>
  </div>;
});
