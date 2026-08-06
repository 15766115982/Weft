// NDJSON line writer for streaming tasks (chat, deep-research).
import fs from 'node:fs';
import path from 'node:path';

export function createNdjsonWriter(outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const stream = fs.createWriteStream(outputPath, { flags: 'w' });
  let finished = false;
  return {
    write(obj) {
      if (finished || !stream.writable) return;
      stream.write(JSON.stringify(obj) + '\n');
    },
    end(obj) {
      if (obj !== undefined) this.write(obj);
      finished = true;
      stream.end();
    },
    finish() {
      return new Promise((resolve, reject) => {
        if (stream.writableFinished || stream.destroyed) return resolve();
        stream.once('finish', resolve);
        stream.once('error', reject);
      });
    },
    close() {
      finished = true;
      stream.destroy();
    },
  };
}
