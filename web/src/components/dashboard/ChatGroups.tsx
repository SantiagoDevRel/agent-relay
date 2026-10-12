import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Folder, Layers } from 'lucide-react';
import type { Chat, Notify } from '@/lib/types';
import { useTarget } from '@/lib/attention';
import { buildFolderTree, chatProject, sortChats, stateOrder, type FolderNode } from '@/lib/chat-groups';
import { states } from './StateBadge';
import { ChatRow, ProjectOptions } from './ChatRow';
import { Button } from './Controls';

type GroupProps = { now: number; onNotify: Notify; showClosed: boolean };

function StateDots({ chats }: { chats: Chat[] }) {
  return <span className="group-dots">{stateOrder.map(state => {
    const count = chats.filter(chat => chat.state === state).length;
    return count ? <span key={state} className={`group-dot state-${state}`} title={`${states[state].plural}: ${count}`}><span className="sr-only">{states[state].plural}: {count}</span></span> : null;
  })}</span>;
}

// A group picked on the radar opens itself so its card can scroll into view.
function useOpensForTarget(chats: Chat[], open: () => void) {
  const target = useTarget();
  const contains = Boolean(target) && chats.some(chat => chat.id === target!.id);
  // `open` is a fresh closure each render; only a new pick should re-run this.
  useEffect(() => { if (contains) open(); }, [contains, target?.seq]);
}

// Active chats first; closed ones stay one click away so the live work stands out.
function ChatList({ chats, now, onNotify, showClosed, showFolder }: GroupProps & { chats: Chat[]; showFolder?: boolean }) {
  const [openClosed, setOpenClosed] = useState(false);
  const sorted = sortChats(chats);
  const active = sorted.filter(chat => chat.state !== 'closed' || chat.favorite);
  const closed = sorted.filter(chat => chat.state === 'closed' && !chat.favorite);
  useOpensForTarget(closed, () => setOpenClosed(true));
  const expanded = showClosed || openClosed;
  return <>
    {active.length > 0 && <div className="chat-grid">{active.map(chat => <ChatRow key={chat.id} chat={chat} now={now} showFolder={showFolder} onNotify={onNotify} />)}</div>}
    {closed.length > 0 && !showClosed && <Button className="closed-toggle" aria-expanded={openClosed} onClick={() => setOpenClosed(!openClosed)}>
      {openClosed ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{openClosed ? 'Hide closed chats' : `View ${closed.length} closed ${closed.length === 1 ? 'chat' : 'chats'}`}
    </Button>}
    {expanded && closed.length > 0 && <div className="chat-grid">{closed.map(chat => <ChatRow key={chat.id} chat={chat} now={now} showFolder={showFolder} onNotify={onNotify} />)}</div>}
  </>;
}

function GroupHeader({ collapsed, controls, onToggle, icon, label, chats }: {
  collapsed: boolean; controls: string; onToggle: () => void; icon: ReactNode; label: ReactNode; chats: Chat[];
}) {
  return <Button className="group-header" aria-expanded={!collapsed} aria-controls={controls} onClick={onToggle}>
    {collapsed ? <ChevronRight className="group-chevron" size={16} /> : <ChevronDown className="group-chevron" size={16} />}
    <span className="group-glyph" aria-hidden="true">{icon}</span>
    {label}
    <span className="group-count">{chats.length}</span><StateDots chats={chats} />
    <span className="group-rule" aria-hidden="true" />
  </Button>;
}

function FolderGroup({ node, parentPath, now, onNotify, showClosed }: GroupProps & { node: FolderNode; parentPath?: string }) {
  const [collapsed, setCollapsed] = useState(true);
  useOpensForTarget(node.all, () => setCollapsed(false));
  // Nested folders show only the part below their parent; the guide line shows the rest.
  const relative = parentPath ? node.path.slice(parentPath.length + 1) : node.path;
  const segments = relative.split('/');
  const name = node.path ? segments.pop() : 'workspace';
  const prefix = segments.join('/');
  const contentId = `folder-${encodeURIComponent(node.path || 'root')}`;
  return <section className={`folder-group ${parentPath !== undefined ? 'nested-group' : ''}`}>
    <GroupHeader collapsed={collapsed} controls={contentId} onToggle={() => setCollapsed(!collapsed)} chats={node.all}
      icon={<Folder size={16} />} label={<span className="group-label">{prefix && <span className="parent-path">{prefix}/</span>}{name}</span>} />
    {!collapsed && <div id={contentId} className="group-content">
      <ChatList chats={node.chats} now={now} onNotify={onNotify} showClosed={showClosed} />
      {node.children.length > 0 && <div className="folder-children">{node.children.map(child => <FolderGroup key={child.path} node={child} parentPath={node.path} now={now} onNotify={onNotify} showClosed={showClosed} />)}</div>}
    </div>}
  </section>;
}

function TopicGroup({ topic, index, chats, now, onNotify, showClosed }: GroupProps & { topic: string; index: number; chats: Chat[] }) {
  const [collapsed, setCollapsed] = useState(false);
  useOpensForTarget(chats, () => setCollapsed(false));
  return <section className="folder-group">
    <GroupHeader collapsed={collapsed} controls={`topic-${index}`} onToggle={() => setCollapsed(!collapsed)} chats={chats}
      icon={<Layers className={`topic-${index % 5}`} size={16} />} label={<span className="group-label">{topic}</span>} />
    {!collapsed && <div id={`topic-${index}`} className="group-content"><ChatList chats={chats} now={now} onNotify={onNotify} showClosed={showClosed} showFolder /></div>}
  </section>;
}

export function ChatGroups({ chats, view, now, onNotify, showClosed }: GroupProps & { chats: Chat[]; view: 'folder' | 'topic' }) {
  const projects = useMemo(()=>[...new Set(['', ...chats.flatMap(chat=>[chat.folder,chatProject(chat)])])].sort((a,b)=>a.localeCompare(b,'en-US')), [chats]);
  if (view === 'folder') return <ProjectOptions value={projects}><div className="chat-groups">{buildFolderTree(chats).map(node => <FolderGroup key={node.path} node={node} now={now} onNotify={onNotify} showClosed={showClosed} />)}</div></ProjectOptions>;
  const topics = [...new Set(chats.map(chat => chat.topic))].sort((a, b) => a.localeCompare(b, 'en-US'));
  return <ProjectOptions value={projects}><div className="chat-groups">{topics.map((topic, index) => <TopicGroup key={topic} topic={topic} index={index} chats={chats.filter(chat => chat.topic === topic)} now={now} onNotify={onNotify} showClosed={showClosed} />)}</div></ProjectOptions>;
}
