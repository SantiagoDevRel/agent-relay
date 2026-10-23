// Bounded streaming JSONL reader over a read-only file descriptor. Memory stays
// O(chunk + maxLineBytes): a line longer than maxLineBytes is dropped while
// scanning to its newline, without accumulating it.
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

const CHUNK = 256 * 1024;

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Extraction aborted.');
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

// Yields { text } for each complete line (UTF-8 decoded only at line ends, so
// code points split across chunks stay intact) or { oversized: true }.
// A final line without a trailing newline is yielded too.
export async function* readLines(file, { signal, maxLineBytes = 8 * 1024 * 1024, chunkBytes = CHUNK } = {}) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(chunkBytes);
    let parts = [], pending = 0, dropping = false, position = 0;
    for (;;) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      let start = 0;
      while (start < bytesRead) {
        const newline = buffer.indexOf(10, start);
        const end = newline === -1 || newline >= bytesRead ? bytesRead : newline;
        if (!dropping) {
          const length = end - start;
          if (pending + length > maxLineBytes) {
            dropping = true; parts = []; pending = 0;
          } else if (length) {
            parts.push(Buffer.from(buffer.subarray(start, end)));
            pending += length;
          }
        }
        if (end === bytesRead) break;
        // Complete line.
        if (dropping) yield { oversized: true };
        else if (pending) yield { text: (parts.length === 1 ? parts[0] : Buffer.concat(parts, pending)).toString('utf8') };
        else yield { text: '' };
        parts = []; pending = 0; dropping = false;
        start = newline + 1;
      }
    }
    if (dropping) yield { oversized: true };
    else if (pending) yield { text: Buffer.concat(parts, pending).toString('utf8') };
  } finally {
    await handle.close();
  }
}
