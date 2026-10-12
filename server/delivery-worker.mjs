import { parentPort } from 'node:worker_threads';
import { DeliveryGit, applyProjectCollisions, execute } from './delivery-git.mjs';
import { DeliveryTranscripts, pathKey } from './delivery-transcript.mjs';

let currentChat;
const git = new DeliveryGit({ exec: (file, args, options) => {
  parentPort.postMessage({ progress: { chatId: currentChat, phase: `${file} ${args.slice(0, 2).join(' ')}`, at: Date.now() } });
  return execute(file, args, options);
} }), transcripts = new DeliveryTranscripts();
let saved = new Map();
parentPort.on('message', async ({ chats }) => {
  const values = new Map([...saved].filter(([id]) => chats.some(chat => chat.id === id))), repositories = new Map();
  const activeChatIds = new Set(chats.filter(chat => chat.alive && !chat.automated).map(chat => chat.id));
  const publish = (done = false) => {
    // Keep collision state coherent on each incremental publication, not only at pass end.
    for (const repo of repositories.values()) applyProjectCollisions(values, repo, activeChatIds);
    parentPort.postMessage({ values: [...values], ...(done ? { done: true } : {}) });
  };
  try {
    // Live lanes get their first evidence before historical chats.
    const pending = [...chats].sort((a, b) => Number(b.alive) - Number(a.alive));
    while (pending.length) {
      const chat = pending.shift();
      currentChat = chat.id;
      parentPort.postMessage({ progress: { chatId: chat.id, phase: 'repository', pending: pending.length } });
      try {
        const root = await git.root(chat.cwd);
        if (!root) { values.set(chat.id, { state: 'no-code', lanes: [], checkedAt: Date.now(), attention: [] }); publish(); continue; }
        let repo = repositories.get(pathKey(root));
        if (!repo) { repo = await git.repository(root); repositories.set(pathKey(root), repo); }
        parentPort.postMessage({ progress: { chatId: chat.id, phase: 'transcript', pending: pending.length } });
        const transcript = await transcripts.read(chat);
        if (!transcript.atEnd) {
          pending.push(chat);
          if (!values.has(chat.id)) values.set(chat.id, { state: 'unknown', lanes: [], project: root, coverage: 'indexing', scannedBytes: transcript.scannedBytes, totalBytes: transcript.totalBytes, checkedAt: Date.now(), attention: [] });
          publish();
          continue;
        }
        parentPort.postMessage({ progress: { chatId: chat.id, phase: 'git', pending: pending.length } });
        values.set(chat.id, await git.chat(repo, chat, transcript));
      } catch (error) { values.set(chat.id, { state: 'unknown', coverage: 'unavailable', lanes: [], checkedAt: Date.now(), attention: [], error: error.message }); }
      // Publish completed chat evidence without waiting for slower projects.
      publish();
    }
    publish(true);
    saved = values;
    for (const file of transcripts.cache.keys()) if (!chats.some(c => c.file === file)) transcripts.cache.delete(file);
  } catch { parentPort.postMessage({ error: 'Delivery collection failed', done: true }); }
});
