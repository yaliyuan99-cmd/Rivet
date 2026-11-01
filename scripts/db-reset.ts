// Deletes the local database and uploads, then re-creates the demo seed.
import { rmSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../server/config.ts';
import { migrate, openDb } from '../server/db/index.ts';
import { seedIfEmpty } from '../server/db/seed/index.ts';
import { localStorage } from '../server/lib/storage.ts';

const config = loadConfig();
for (const name of ['rivet.db', 'rivet.db-wal', 'rivet.db-shm', 'uploads']) {
  rmSync(path.join(config.dataDir, name), { recursive: true, force: true });
}
const db = openDb(path.join(config.dataDir, 'rivet.db'));
await migrate(db);
await seedIfEmpty({ db, config, storage: localStorage(config.dataDir), now: () => new Date() });
db.close();
console.log(`Reset ${config.dataDir}`);
