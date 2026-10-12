import { createContext, useContext } from 'react';
import type { Chat } from './types';

const RANK: Partial<Record<Chat['state'], number>> = { cut: 0, unknown: 1, waiting: 2 };

export function chatNextStep(chat: Chat) {
  if (chat.state === 'waiting') return 'Your turn. Read the conversation, then reply there or use Go to chat.';
  if (chat.state === 'cut') return chat.canOpen ? 'The turn was interrupted. Review the saved conversation, then use Open to resume.' : 'The turn was interrupted. Review the saved conversation and the resume command below.';
  if (chat.state === 'unknown') return 'Status is not verified. Read the saved conversation before deciding what to do.';
  if (chat.state === 'closed') return chat.canOpen ? 'The chat is closed. Review its conversation or use Open to continue.' : 'The chat is closed. Its saved conversation is available to review.';
  return chat.delivery?.attention?.length ? 'The agent is working. Review the Delivery evidence before deciding whether to intervene.' : 'The agent is working. Follow its progress here or read the conversation.';
}

// Chats that need you: cut first (their process died mid-turn), then unknown,
// then the ones waiting for your reply, newest first. The radar numbers its
// markers with this same order.
export function attentionChats(chats: Chat[]) {
  return chats
    .filter(chat => RANK[chat.state] !== undefined || Boolean(chat.delivery?.attention?.length))
    .sort((a, b) => (a.delivery?.attention?.length ? 0 : RANK[a.state] ?? 3) - (b.delivery?.attention?.length ? 0 : RANK[b.state] ?? 3) || b.lastActivity - a.lastActivity);
}

// The chat picked on the radar or in "Needs you now": its card scrolls into
// view and glows. `seq` lets the same chat be picked twice in a row.
export type Target = { id: string; seq: number } | null;
export const TargetContext = createContext<Target>(null);
export const useTarget = () => useContext(TargetContext);
