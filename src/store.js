import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPath = fileURLToPath(new URL('../data/scopeshield.sqlite', import.meta.url));
export const validToken = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);

export function publicProposal(row) {
  return {
    title: row.title, work: row.work, delivery: row.delivery,
    amountCents: row.amount_cents, currency: row.currency,
    createdAt: row.created_at, status: row.payment_status,
    captureId: row.capture_id, paidAt: row.paid_at,
  };
}

export function openStore(path = defaultPath) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    if (!existsSync(path)) {
      // SQLite's journal must inherit private permissions, including during creation.
      const oldMask = process.umask(0o077);
      try { const initial = new DatabaseSync(path); initial.close(); }
      finally { process.umask(oldMask); }
    }
    chmodSync(path, 0o600);
  }
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      work TEXT NOT NULL,
      delivery TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 99999999),
      currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency = 'USD'),
      created_at TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      accepted_at TEXT,
      order_id TEXT UNIQUE,
      approval_url TEXT,
      create_request_id TEXT,
      create_started_at TEXT,
      capture_request_id TEXT,
      capture_started_at TEXT,
      capture_id TEXT UNIQUE,
      paid_at TEXT
    );
    CREATE TRIGGER IF NOT EXISTS fixed_proposal_terms
    BEFORE UPDATE OF id, token, title, work, delivery, amount_cents, currency, created_at ON proposals
    BEGIN SELECT RAISE(ABORT, 'Published terms cannot be changed'); END;
  `);
  if (!db.prepare('PRAGMA table_info(proposals)').all().some(column => column.name === 'merchant_id')) {
    db.exec('ALTER TABLE proposals ADD COLUMN merchant_id TEXT');
  }
  if (!db.prepare('PRAGMA table_info(proposals)').all().some(column => column.name === 'deleted_at')) {
    db.exec('ALTER TABLE proposals ADD COLUMN deleted_at TEXT');
  }
  if (!db.prepare('PRAGMA table_info(proposals)').all().some(column => column.name === 'owner_id')) {
    db.exec('ALTER TABLE proposals ADD COLUMN owner_id TEXT REFERENCES users(id)');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS proposals_owner ON proposals(owner_id);
    CREATE TRIGGER IF NOT EXISTS fixed_proposal_owner BEFORE UPDATE OF owner_id ON proposals
    WHEN OLD.owner_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Proposal owner cannot be changed'); END;`);
  const paymentFields = new Set(['payment_status', 'accepted_at', 'order_id', 'approval_url', 'create_request_id',
    'create_started_at', 'capture_request_id', 'capture_started_at', 'capture_id', 'paid_at', 'merchant_id']);
  const get = db.prepare('SELECT * FROM proposals WHERE token = ? AND deleted_at IS NULL');
  return {
    create({ title, work, delivery, amountCents }, ownerId = null) {
      const token = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO proposals (id, token, title, work, delivery, amount_cents, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), token, title, work, delivery, amountCents, new Date().toISOString(), ownerId);
      return get.get(token);
    },
    get(token) { return validToken(token) ? get.get(token) : undefined; },
    list(ownerId = null) { return db.prepare('SELECT * FROM proposals WHERE owner_id IS ? AND deleted_at IS NULL ORDER BY created_at DESC, rowid DESC').all(ownerId); },
    userByEmail(email) { return db.prepare('SELECT * FROM users WHERE email = ?').get(email); },
    userById(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); },
    createUser({ name, email, passwordHash }) {
      const id = randomUUID();
      db.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, email, passwordHash, new Date().toISOString());
      return this.userById(id);
    },
    assignLegacy(userId) {
      return db.prepare('UPDATE proposals SET owner_id = ? WHERE owner_id IS NULL').run(userId).changes;
    },
    remove(token) {
      db.prepare('UPDATE proposals SET deleted_at = ? WHERE token = ? AND deleted_at IS NULL')
        .run(new Date().toISOString(), token);
    },
    updatePayment(token, fields) {
      const keys = Object.keys(fields);
      if (!keys.length || keys.some(key => !paymentFields.has(key))) throw new Error('Invalid payment update.');
      db.prepare(`UPDATE proposals SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE token = ? AND deleted_at IS NULL`)
        .run(...keys.map(key => fields[key]), token);
      return get.get(token);
    },
    close() { db.close(); },
  };
}
