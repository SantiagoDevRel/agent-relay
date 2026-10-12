import { memo, useMemo, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import type { Chat, ChatState } from '@/lib/types';
import { attentionChats } from '@/lib/attention';
import { chatProject, relativeTime } from '@/lib/chat-groups';
import { Radar } from './Radar';
import { states } from './StateBadge';
import { ToolLogo } from './ToolLogo';

const KPIS = ['working', 'waiting', 'cut', 'closed'] as const;
const ATTENTION_PREVIEW = 6;

function hint(state: (typeof KPIS)[number], days: number) {
  if (state === 'working') return 'Agents working';
  if (state === 'waiting') return 'Your turn';
  if (state === 'cut') return 'To resume';
  return days === 1 ? 'Last day' : `Last ${days} days`;
}

type HeroProps = {
  chats: Chat[];
  counts: Record<ChatState, number>;
  now: number;
  windowDays: number;
  paused: boolean;
  active: boolean;
  filter: ChatState | null;
  onFilter: (state: ChatState | null) => void;
  onSelect: (id: string) => void;
};

export const Hero = memo(function Hero({ chats, counts, now, windowDays, paused, active, filter, onFilter, onSelect }: HeroProps) {
  const attention = useMemo(() => attentionChats(chats), [chats]);
  const numbers = useMemo(() => new Map(attention.map((chat,index)=>[chat.id,index+1])),[attention]);
  const open = useMemo(() => chats.filter(chat => chat.alive).length, [chats]);
  const toggle = (state: ChatState) => onFilter(filter === state ? null : state);

  return <section className="hero" aria-label="Summary">
      <div className="kpi-grid" role="group" aria-label="Filter by status">
        {KPIS.map(state => {
          const { Icon, plural } = states[state];
          return <button key={state} type="button" className={`kpi state-${state}`} aria-pressed={filter === state} onClick={() => toggle(state)}>
            <span className="kpi-label"><Icon size={15} aria-hidden="true" />{plural}</span>
            <span className="kpi-value">{counts[state]}</span>
            <span className="kpi-hint">{hint(state, windowDays)}</span>
          </button>;
        })}
      </div>
      {counts.unknown > 0 && <button type="button" className="unknown-chip state-unknown" aria-pressed={filter === 'unknown'} onClick={() => toggle('unknown')}>
        <CircleHelp size={15} aria-hidden="true" />{counts.unknown} {counts.unknown === 1 ? 'chat with unknown status' : 'chats with unknown status'}
      </button>}

    <div className="panel radar-panel">
      <div className="panel-head">
        <h2>Radar</h2>
        <span className="radar-open"><span className="open-dot" aria-hidden="true" />{open} {open === 1 ? 'open' : 'open'}</span>
        <p className="panel-caption">Select a logo to see its name, status and delivery stage. Color shows whether it is working or waiting for you.</p>
      </div>
      <Radar chats={chats} now={now} windowDays={windowDays} numbers={numbers} paused={paused} active={active} onSelect={onSelect}/>
      <div className="radar-legend" role="group" aria-label="Radar legend">
        <ul className="legend-states">{(['waiting','working','cut','closed'] as const).map(state=><li key={state} className={`state-${state}`}><span className="legend-swatch"/>{states[state].plural}</li>)}</ul>
        <ul className="legend-tools"><li><ToolLogo tool="claude"/>Claude</li><li><ToolLogo tool="codex"/>Codex</li></ul>
      </div>
    </div>

  </section>;
});

export function AttentionPanel({ chats, now, onSelect }: { chats: Chat[]; now: number; onSelect: (id: string) => void }) {
  const attention = useMemo(() => attentionChats(chats), [chats]);
  const [showAll, setShowAll] = useState(false);
  const listed = showAll ? attention : attention.slice(0, ATTENTION_PREVIEW);
  return <div className="panel attention-panel">
        <div className="panel-head"><h2>Needs you now</h2><span className="attention-count">{attention.length}</span></div>
        {attention.length ? <ol className="attention-list">
          {listed.map((chat, index) => <li key={chat.id}>
            <button type="button" className={`attention-item state-${chat.state} ${chat.delivery?.attention?.length ? 'delivery-attention' : ''}`} onClick={() => onSelect(chat.id)}>
              <span className="attention-number" aria-hidden="true">{index + 1}</span>
              <span className="attention-text">
                <strong>{chat.title}</strong>
                <span className="attention-meta">{chat.delivery?.attention?.length ? chat.delivery.attention.join(' · ') : states[chat.state].label} · {chat.tool === 'claude' ? 'Claude' : 'Codex'} · {chatProject(chat) || 'Environment'}</span>
              </span>
              <time className="attention-time" dateTime={new Date(chat.lastActivity).toISOString()}>{relativeTime(chat.lastActivity, now)}</time>
            </button>
          </li>)}
        </ol> : <p className="attention-empty">Nothing is waiting for you: everything is working or closed.</p>}
        {attention.length > ATTENTION_PREVIEW && <button type="button" className="action-button show-all" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show less' : `View all ${attention.length}`}
        </button>}
      </div>;
}
