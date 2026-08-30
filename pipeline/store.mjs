import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.owner = randomUUID();
    this.db = new DatabaseSync(path.join(directory, 'pipeline.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lock(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, pid INTEGER, host TEXT);
      CREATE TABLE IF NOT EXISTS leads(id TEXT PRIMARY KEY, cycle TEXT NOT NULL, source TEXT NOT NULL,
        lead TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, error TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS quarantine(id TEXT PRIMARY KEY, cycle TEXT, source TEXT, reason TEXT);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS daily(day TEXT PRIMARY KEY, searches INTEGER NOT NULL DEFAULT 0,
        validations INTEGER NOT NULL DEFAULT 0);`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  acquire() {
    return this.transaction(() => {
      const lock = this.db.prepare('SELECT * FROM lock WHERE id=1').get();
      // Never expire a live owner's lock: a slow/suspended worker must not be overlapped.
      if (lock && (lock.host !== os.hostname() || alive(lock.pid))) return false;
      this.db.prepare('INSERT OR REPLACE INTO lock VALUES(1,?,?,?)').run(this.owner, process.pid, os.hostname());
      return true;
    });
  }
  release() { this.db.prepare('DELETE FROM lock WHERE owner=?').run(this.owner); }
  get(key, fallback = null) { const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return r ? JSON.parse(r.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, JSON.stringify(value)); }
  daily(day) { return this.db.prepare('SELECT * FROM daily WHERE day=?').get(day) || { searches: 0, validations: 0 }; }
  totals() { return this.db.prepare('SELECT coalesce(sum(searches),0) searches, coalesce(sum(validations),0) validations FROM daily').get(); }
  charge(day, kind) {
    if (!['searches','validations'].includes(kind)) throw new Error('Invalid budget counter');
    this.db.prepare('INSERT OR IGNORE INTO daily(day) VALUES(?)').run(day);
    this.db.prepare(`UPDATE daily SET ${kind}=${kind}+1 WHERE day=?`).run(day);
  }
  rows() { return this.db.prepare('SELECT * FROM leads ORDER BY created,id').all(); }
  pending(limit) { return this.db.prepare("SELECT * FROM leads WHERE status='pending' ORDER BY created,id LIMIT ?").all(limit); }
  count() { return this.db.prepare('SELECT count(*) AS n FROM leads').get().n; }
  insert(id, cycle, source, lead, now) {
    return this.db.prepare('INSERT OR IGNORE INTO leads(id,cycle,source,lead,created) VALUES(?,?,?,?,?)')
      .run(id, cycle, JSON.stringify(source), JSON.stringify(lead), now).changes;
  }
  complete(id, result) { this.db.prepare("UPDATE leads SET status='complete',result=? WHERE id=?").run(JSON.stringify(result), id); }
  auditRun(cycle) { this.db.prepare('INSERT OR REPLACE INTO runs VALUES(?,?)').run(cycle.id, JSON.stringify(cycle)); }
  close() { this.db.close(); }
}
