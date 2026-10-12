// User-requested messages to existing native chats; no automatic replay.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readConversation } from './summary.mjs';
import { enrollChat, messageInput, messageCommand } from './relay-transport.mjs';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fail = (message, status = 409) => Object.assign(Error(message), { status });
export class ChatControl {
  constructor({ targets, artifacts, leased = () => false, enroll = enrollChat, deliver = messageInput }) {
    Object.assign(this, { targets, artifacts, leased, enroll, deliver }); this.pending = new Set();
  }
  chat(id) {
    const chat = UUID.test(id || '') && this.targets().get(id);
    if (!chat?.file) throw fail('Chat not found.', 404);
    return chat;
  }
  conversation(id) {
    const chat = this.chat(id), read = readConversation(chat.tool, chat.file);
    const messages = []; let remaining = 200000, truncated = read.partial;
    for (const message of [...read.conv.messages].reverse().slice(0, 200)) {
      if (remaining <= 0) { truncated = true; break; }
      const content = this.userText(id, message);
      const value = { ...message, text: content.slice(-Math.min(remaining, 20000)) };
      if (value.text.length < content.length) truncated = true;
      messages.unshift(value); remaining -= value.text.length;
    }
    if (messages.length < read.conv.messages.length) truncated = true;
    return { id, title: chat.title, messages, partial: truncated, alive: chat.alive, state: chat.state,
      canSend: Boolean(chat.alive && !chat.automated && chat.state === 'waiting' && !this.leased(id) && !this.pending.has(id)),
      leased: this.leased(id) };
  }
  userText(chatId, message) {
    if (message.role !== 'user') return message.text;
    const id = message.text.match(/^AGENT-RELAY MESSAGE ([a-f0-9-]{36}): /)?.[1];
    if (!UUID.test(id || '')) return message.text;
    const folder = path.join(this.artifacts, id), file = path.join(folder, 'user-message.md'), receipt = path.join(folder, 'message.json');
    if (message.text !== messageCommand(file, id)) return message.text;
    try {
      if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 65536 || !fs.lstatSync(receipt).isFile() || fs.statSync(receipt).size > 8192) return message.text;
      const record = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      if (record.id !== id || record.chatId !== chatId) return message.text;
      const stored = fs.readFileSync(file, 'utf8'), prefix = '# Message from the user\n\n';
      return stored.startsWith(prefix) ? stored.slice(prefix.length).replace(/\n$/, '') : message.text;
    } catch { return message.text; }
  }
  async message(id, text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 12000 || /\x00/.test(text) || /^\s*\//.test(text)) throw fail('Write a message of up to 12,000 characters. Use terminal commands on the laptop.', 400);
    const chat = this.chat(id);
    if (this.pending.has(id)) throw fail('A message is already being sent.', 429);
    if (this.leased(id)) throw fail('This chat belongs to an active cycle. Stop that cycle before sending manual instructions.');
    if (!chat.alive || chat.automated || chat.state !== 'waiting') throw fail('Wait until the chat finishes its turn and its input field is empty.');
    this.pending.add(id);
    try {
      const enrolled = await this.enroll(chat), requestId = crypto.randomUUID(), folder = path.join(this.artifacts, requestId);
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, 'user-message.md'), receipt = path.join(folder, 'message.json');
      fs.writeFileSync(file, `# Message from the user\n\n${text}\n`, { flag: 'wx' });
      const record = { id: requestId, chatId: id, createdAt: Date.now(), status: 'submitting' };
      fs.writeFileSync(receipt, JSON.stringify(record));
      // Re-read server-owned chat metadata after enrollment, before console delivery.
      const current = this.chat(id);
      if (this.leased(id)) throw fail('The chat just joined an active cycle. The message was not sent.');
      try {
        await this.deliver(current, enrolled, file, requestId);
        record.status = 'submitted'; fs.writeFileSync(receipt, JSON.stringify(record));
        return { id: requestId, status: 'submitted' };
      } catch (error) {
        record.status = 'uncertain'; record.detail = error.message; fs.writeFileSync(receipt, JSON.stringify(record));
        throw fail('Delivery could not be confirmed. Review the conversation before trying again; the message was not resent automatically.');
      }
    } finally { this.pending.delete(id); }
  }
}
