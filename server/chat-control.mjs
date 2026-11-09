// User-requested messages to existing native chats; no automatic replay.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readConversation } from './summary.mjs';
import { enrollChat, messageInput, messageCommand } from './relay-transport.mjs';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fail = (message, status = 409) => Object.assign(Error(message), { status });

function notSentText(tool, reason, platform) {
  if (platform === 'win32' && tool === 'claude' && reason === 'draft') {
    return "Not sent: the chat's input field shows text. On Windows, Relay cannot tell Claude's grey suggestion from a draft. Nothing was typed; clear the input field or turn off prompt suggestions in /config before trying again.";
  }
  const explanation = {
    draft: "the chat's input field has a draft. Nothing was typed; clear the draft in the chat before trying again.",
    busy: 'the chat is busy. Nothing was typed; wait until it finishes before trying again.',
    menu: 'the chat has a selection or permission menu open. Nothing was typed; resolve it in the chat before trying again.',
    'copy-mode': 'the terminal is in copy mode. Nothing was typed; leave copy mode in the terminal before trying again.',
    identity: 'the chat identity could not be verified. Nothing was typed; reopen the conversation and check the chat before trying again.',
    'frame-changed': 'the screen kept changing between captures. Nothing was typed; wait until the chat is idle before trying again.',
    'no-style': 'Relay could not verify the input styling. Nothing was typed; check the input field in the chat before trying again.',
  }[reason];
  return `Not sent: ${explanation || `Relay does not recognize this chat's screen (${tool}). Nothing was typed; open the chat in the ${tool === 'claude' ? 'Claude app' : 'Codex terminal'}.`}`;
}

// A transport may provide a bounded snapshot only for recognition failures.
// Enforce the privacy and byte limits again at the receipt boundary.
function saveRefusal(folder, tool, reason, refusal) {
  if (!['no-composer', 'frame-changed', 'no-style'].includes(reason) || !refusal) return;
  const rows = value => Array.isArray(value) ? value.slice(0, 12).map(row => String(row).slice(0, 1024)) : [];
  const snapshot = { tool, reason, cursor: Array.isArray(refusal.cursor) ? refusal.cursor.slice(0, 4).map(n => Number.isInteger(n) ? n : null) : [],
    ...(typeof refusal.cliVersion === 'string' ? { cliVersion: refusal.cliVersion.slice(0, 128) } : {}),
    plain: rows(refusal.plain), styled: rows(refusal.styled) };
  let json = JSON.stringify(snapshot);
  while (Buffer.byteLength(json) > 16 * 1024) {
    snapshot.plain = snapshot.plain.map(row => row.slice(0, Math.floor(row.length / 2)));
    snapshot.styled = snapshot.styled.map(row => row.slice(0, Math.floor(row.length / 2)));
    json = JSON.stringify(snapshot);
  }
  fs.writeFileSync(path.join(folder, 'refusal.json'), json, { flag: 'wx', mode: 0o600 });
}
export class ChatControl {
  constructor({ targets, artifacts, leased = () => false, enroll = enrollChat, deliver = messageInput, platform = process.platform }) {
    Object.assign(this, { targets, artifacts, leased, enroll, deliver, platform }); this.pending = new Set();
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
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const file = path.join(folder, 'user-message.md'), receipt = path.join(folder, 'message.json');
      fs.writeFileSync(file, `# Message from the user\n\n${text}\n`, { flag: 'wx', mode: 0o600 });
      const record = { id: requestId, chatId: id, createdAt: Date.now(), status: 'submitting' };
      fs.writeFileSync(receipt, JSON.stringify(record), { mode: 0o600 });
      // Re-read server-owned chat metadata after enrollment, before console delivery.
      const current = this.chat(id);
      if (this.leased(id)) throw fail('The chat just joined an active cycle. The message was not sent.');
      try {
        await this.deliver(current, enrolled, file, requestId);
        record.status = 'submitted'; fs.writeFileSync(receipt, JSON.stringify(record));
        return { id: requestId, status: 'submitted' };
      } catch (error) {
        if (error.code === 'RELAY_NOT_SENT') {
          record.status = 'not-sent'; record.reason = error.reason; record.detail = error.message;
          try { saveRefusal(folder, chat.tool, error.reason, error.refusal); }
          catch { record.diagnosticsUnavailable = true; }
          fs.writeFileSync(receipt, JSON.stringify(record));
          throw Object.assign(fail(notSentText(chat.tool, error.reason, this.platform)), { code: error.code, reason: error.reason });
        }
        record.status = 'uncertain'; record.detail = error.message; fs.writeFileSync(receipt, JSON.stringify(record));
        throw fail('Delivery could not be confirmed. Review the conversation before trying again; the message was not resent automatically.');
      }
    } finally { this.pending.delete(id); }
  }
}
