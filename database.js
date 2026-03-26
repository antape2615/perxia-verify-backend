import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'contracts.db');

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initializeSchema();
  }
  return db;
}

function initializeSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      parent_path TEXT,
      level INTEGER DEFAULT 0,
      main_category TEXT,
      client_name TEXT,
      ai_summary TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_path);
    CREATE INDEX IF NOT EXISTS idx_folders_level ON folders(level);
    CREATE INDEX IF NOT EXISTS idx_folders_category ON folders(main_category);

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT UNIQUE NOT NULL,
      file_name TEXT NOT NULL,
      folder TEXT,
      folder_id INTEGER,
      doc_type TEXT DEFAULT 'Otro',
      main_category TEXT,
      client_name TEXT,
      client TEXT,
      contract_number TEXT,
      contract_type TEXT,
      start_date TEXT,
      end_date TEXT,
      value TEXT,
      currency TEXT,
      terms TEXT,
      agreements TEXT,
      parties TEXT,
      obligations TEXT,
      penalties TEXT,
      guarantees TEXT,
      scope TEXT,
      payment_terms TEXT,
      renewal_clause TEXT,
      termination_clause TEXT,
      summary TEXT,
      raw_text TEXT,
      ai_analysis TEXT,
      status TEXT DEFAULT 'pending',
      processed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (folder_id) REFERENCES folders(id)
    );

    CREATE INDEX IF NOT EXISTS idx_docs_client ON documents(client);
    CREATE INDEX IF NOT EXISTS idx_docs_status ON documents(status);
    CREATE INDEX IF NOT EXISTS idx_docs_file_name ON documents(file_name);
    CREATE INDEX IF NOT EXISTS idx_docs_folder ON documents(folder);
    CREATE INDEX IF NOT EXISTS idx_docs_folder_id ON documents(folder_id);
    CREATE INDEX IF NOT EXISTS idx_docs_doc_type ON documents(doc_type);
    CREATE INDEX IF NOT EXISTS idx_docs_main_category ON documents(main_category);
    CREATE INDEX IF NOT EXISTS idx_docs_client_name ON documents(client_name);

    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      file_name, client, contract_number, summary, terms, agreements, parties, raw_text, folder, doc_type,
      content='documents',
      content_rowid='id'
    );

    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER,
      session_type TEXT DEFAULT 'document',
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (document_id) REFERENCES documents(id)
    );

    CREATE TABLE IF NOT EXISTS processing_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT,
      folder_path TEXT,
      status TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  try {
    db.exec(`DROP TRIGGER IF EXISTS docs_ai;`);
    db.exec(`DROP TRIGGER IF EXISTS docs_ad;`);
    db.exec(`DROP TRIGGER IF EXISTS docs_au;`);
  } catch { /* ignore */ }

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON documents BEGIN
      INSERT INTO docs_fts(rowid, file_name, client, contract_number, summary, terms, agreements, parties, raw_text, folder, doc_type)
      VALUES (new.id, new.file_name, new.client, new.contract_number, new.summary, new.terms, new.agreements, new.parties, new.raw_text, new.folder, new.doc_type);
    END;

    CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON documents BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, file_name, client, contract_number, summary, terms, agreements, parties, raw_text, folder, doc_type)
      VALUES ('delete', old.id, old.file_name, old.client, old.contract_number, old.summary, old.terms, old.agreements, old.parties, old.raw_text, old.folder, old.doc_type);
    END;

    CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON documents BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, file_name, client, contract_number, summary, terms, agreements, parties, raw_text, folder, doc_type)
      VALUES ('delete', old.id, old.file_name, old.client, old.contract_number, old.summary, old.terms, old.agreements, old.parties, old.raw_text, old.folder, old.doc_type);
      INSERT INTO docs_fts(rowid, file_name, client, contract_number, summary, terms, agreements, parties, raw_text, folder, doc_type)
      VALUES (new.id, new.file_name, new.client, new.contract_number, new.summary, new.terms, new.agreements, new.parties, new.raw_text, new.folder, new.doc_type);
    END;
  `);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
