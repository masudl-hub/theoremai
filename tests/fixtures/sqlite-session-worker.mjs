import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const [path, operation, sessionId, expected] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec('PRAGMA busy_timeout = 10000');
db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)');
try {
  if (operation === 'load') {
    const row = db.prepare('SELECT revision, state FROM sessions WHERE id = ?').get(sessionId);
    process.stdout.write(JSON.stringify(row ? { revision: row.revision, state: JSON.parse(row.state) } : null));
  } else if (operation === 'cas') {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const state = JSON.parse(input);
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare('SELECT revision FROM sessions WHERE id = ?').get(sessionId);
    if ((row?.revision ?? null) !== JSON.parse(expected)) {
      db.exec('ROLLBACK');
      process.stdout.write(JSON.stringify({ written: false }));
    } else {
      const revision = randomUUID();
      db.prepare('INSERT INTO sessions (id, revision, state) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, state = excluded.state')
        .run(sessionId, revision, JSON.stringify(state));
      db.exec('COMMIT');
      process.stdout.write(JSON.stringify({ written: true, revision }));
    }
  } else {
    throw new Error(`Unknown operation: ${operation}`);
  }
} finally {
  db.close();
}
