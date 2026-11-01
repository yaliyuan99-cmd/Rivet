import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { sha256Hex } from './crypto.ts';

/** Content-addressed bytes behind an interface, so blob storage can replace the local folder. */
export interface Storage {
  put(bytes: Uint8Array): Promise<{ sha256: string; size: number }>;
  read(sha256: string): Promise<Uint8Array>;
  stream(sha256: string): ReadableStream;
  exists(sha256: string): boolean;
}

export function localStorage(dataDir: string): Storage {
  const root = path.join(dataDir, 'uploads');
  mkdirSync(root, { recursive: true });
  const fileFor = (sha256: string) => {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid content hash');
    return path.join(root, sha256);
  };
  return {
    async put(bytes) {
      const sha256 = sha256Hex(bytes);
      const file = fileFor(sha256);
      if (!existsSync(file)) writeFileSync(file, bytes);
      return { sha256, size: statSync(file).size };
    },
    read: (sha256) => readFile(fileFor(sha256)),
    stream: (sha256) => Readable.toWeb(createReadStream(fileFor(sha256))) as ReadableStream,
    exists: (sha256) => existsSync(fileFor(sha256)),
  };
}
