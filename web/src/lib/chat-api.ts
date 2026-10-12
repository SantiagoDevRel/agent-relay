export interface Conversation {
  id: string; title: string; messages: { role: 'user' | 'agent'; text: string; ts: number }[];
  partial: boolean; alive: boolean; state: string; canSend: boolean; leased: boolean;
}
const token = () => document.querySelector<HTMLMetaElement>('meta[name="chats-token"]')?.content || '';
export async function chatConversation(id: string, signal?: AbortSignal): Promise<Conversation> {
  const response = await fetch(`/api/chat/conversation?id=${encodeURIComponent(id)}&t=${encodeURIComponent(token())}`, { cache: 'no-store', signal });
  const body = await response.json(); if (!response.ok) throw Error(body.error || 'Could not read the chat.'); return body;
}
export async function sendChatMessage(id: string, text: string) {
  const response = await fetch('/api/chat/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chats-Token': token() },
    body: JSON.stringify({ id, text }), signal: AbortSignal.timeout(30000) });
  const body = await response.json(); if (!response.ok) throw Error(body.error || 'Could not confirm delivery. Check the conversation before sending again.');
  return body as { id: string; status: 'submitted' };
}
