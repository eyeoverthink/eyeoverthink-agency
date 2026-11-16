// SQLite persistence via Node's built-in node:sqlite (no native npm dependency).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  // v1 — core schema
  `
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, description TEXT DEFAULT '',
    model_role TEXT NOT NULL DEFAULT 'reason', tools TEXT NOT NULL DEFAULT '[]', system_prompt TEXT NOT NULL,
    genome TEXT NOT NULL, traits TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL DEFAULT 'builtin',
    generation INTEGER NOT NULL DEFAULT 0, fitness REAL, runs INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1, public_key TEXT, created TEXT NOT NULL, updated TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL, plan TEXT, result TEXT, error TEXT,
    options TEXT NOT NULL DEFAULT '{}', checkpoint TEXT, replans INTEGER NOT NULL DEFAULT 0,
    score REAL, created TEXT NOT NULL, updated TEXT NOT NULL, finished TEXT
  );
  CREATE INDEX IF NOT EXISTS missions_status ON missions(status);

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, agent_id TEXT NOT NULL, title TEXT NOT NULL,
    instructions TEXT NOT NULL, deps TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, output TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, score REAL, critique TEXT, model TEXT, privacy TEXT DEFAULT 'normal',
    started TEXT, finished TEXT, created TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_mission ON tasks(mission_id);

  CREATE TABLE IF NOT EXISTS spans (
    id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL,
    agent_id TEXT, status TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER, attrs TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS spans_trace ON spans(trace_id);

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, agent_id TEXT, scope TEXT NOT NULL DEFAULT 'agency', kind TEXT NOT NULL,
    content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', importance REAL NOT NULL DEFAULT 0.5,
    embedding TEXT, embed_model TEXT, source TEXT, hash TEXT NOT NULL, sig TEXT,
    access_count INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, accessed TEXT, archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS memories_kind ON memories(kind, archived);
  CREATE UNIQUE INDEX IF NOT EXISTS memories_hash ON memories(hash);

  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY, src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1,
    memory_id TEXT, created TEXT NOT NULL, updated TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS edges_triple ON edges(src, rel, dst);
  CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);

  CREATE TABLE IF NOT EXISTS ledger (
    seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL,
    prev TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, sig TEXT NOT NULL, signer TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY, mission_id TEXT, task_id TEXT, agent_id TEXT, tool TEXT NOT NULL, args TEXT NOT NULL,
    reason TEXT, status TEXT NOT NULL DEFAULT 'pending', created TEXT NOT NULL, decided TEXT, decided_by TEXT
  );

  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', def TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    api_key_hash TEXT, created TEXT NOT NULL, updated TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL, input TEXT, output TEXT, node_states TEXT,
    error TEXT, created TEXT NOT NULL, finished TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, channel TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT, type TEXT NOT NULL,
    body TEXT NOT NULL, sig TEXT, verified INTEGER NOT NULL DEFAULT 0, ts TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel, ts);

  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, public_key TEXT NOT NULL,
    trust TEXT NOT NULL DEFAULT 'known', last_seen TEXT, created TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mesh_nonces (nonce TEXT PRIMARY KEY, ts INTEGER NOT NULL);

  CREATE TABLE IF NOT EXISTS evolution (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, generation INTEGER NOT NULL, genome TEXT NOT NULL,
    fitness REAL, parent_a TEXT, parent_b TEXT, promoted INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dreams (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, summary TEXT NOT NULL, inputs TEXT NOT NULL DEFAULT '[]',
    stats TEXT NOT NULL DEFAULT '{}', sig TEXT NOT NULL, created TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bench_runs (
    id TEXT PRIMARY KEY, suite TEXT NOT NULL, results TEXT NOT NULL, score REAL NOT NULL, models TEXT, created TEXT NOT NULL
  );
  `,
  // v2 — full-text index over memories for keyword recall
  `
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, content='memories', content_rowid='rowid');
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, tags ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
    INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
  END;
  `,
];

export class Store {
  constructor(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.path = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#migrate();
    this.cache = new Map();
  }

  #migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version').get();
    let version = row ? row.version : 0;
    if (!row) this.db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[i]);
        this.db.prepare('UPDATE schema_version SET version = ?').run(i + 1);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw new Error(`Migration ${i + 1} failed: ${e.message}`);
      }
    }
  }

  #stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) { s = this.db.prepare(sql); this.cache.set(sql, s); }
    return s;
  }

  run(sql, ...params) { return this.#stmt(sql).run(...params.map(norm)); }
  get(sql, ...params) { return this.#stmt(sql).get(...params.map(norm)); }
  all(sql, ...params) { return this.#stmt(sql).all(...params.map(norm)); }

  /** Run fn inside a transaction; nested calls join the outer transaction. */
  tx(fn) {
    if (this.inTx) return fn();
    this.inTx = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  kvGet(key, fallback = null) {
    const row = this.get('SELECT value FROM kv WHERE key = ?', key);
    return row ? JSON.parse(row.value) : fallback;
  }
  kvSet(key, value) {
    this.run('INSERT INTO kv (key, value, updated) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated',
      key, JSON.stringify(value), new Date().toISOString());
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }
}

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

/** Parse JSON columns on a row in place. */
export function hydrate(row, jsonCols = []) {
  if (!row) return row;
  const out = { ...row };
  for (const c of jsonCols) {
    if (typeof out[c] === 'string') { try { out[c] = JSON.parse(out[c]); } catch { /* keep string */ } }
  }
  return out;
}
