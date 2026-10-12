import type { Chat, ChatState } from './types';
export const stateOrder: ChatState[] = ['working', 'waiting', 'cut', 'unknown', 'closed'];
export const chatProject = (chat: Chat) => (chat.projectFolder ?? chat.folder).replace(/\\/g, '/').replace(/\/+$/, '');
export function sortChats(chats: Chat[]) {
  return [...chats].sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || stateOrder.indexOf(a.state) - stateOrder.indexOf(b.state) || b.lastActivity - a.lastActivity);
}
export interface FolderNode { path: string; chats: Chat[]; children: FolderNode[]; all: Chat[] }
export function buildFolderTree(chats: Chat[]): FolderNode[] {
  const root: FolderNode = { path: '', chats: [], children: [], all: [] };
  for (const chat of chats) {
    let node = root;
    node.all.push(chat);
    let path = '';
    for (const segment of chatProject(chat).split('/').filter(Boolean)) {
      path = path ? `${path}/${segment}` : segment;
      let child = node.children.find(candidate => candidate.path === path);
      if (!child) { child = { path, chats: [], children: [], all: [] }; node.children.push(child); }
      child.all.push(chat); node = child;
    }
    node.chats.push(chat);
  }
  function compact(node: FolderNode): FolderNode {
    node.children = node.children.map(compact).sort((a, b) => a.path.localeCompare(b.path));
    const onlyChild = node.children[0];
    if (!node.chats.length && node.children.length === 1 && onlyChild) return onlyChild;
    return node;
  }
  return [...(root.chats.length ? [{ ...root, children: [], all: root.chats }] : []), ...root.children.map(compact).sort((a, b) => a.path.localeCompare(b.path))];
}
export function relativeTime(time: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86400);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
