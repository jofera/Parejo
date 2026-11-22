import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const COLORS = ['#0b8576', '#c9600a'];

// [emoji, nombre, minutos habituales, posición en pantalla]. Primero las tareas sueltas y luego
// los grupos con sus subtareas (el orden de inserción solo afecta a los identificadores).
const DEFAULT_TASKS = [
  ['🍳', 'Cocinar', 45, 0],
  ['🍽️', 'Recoger la cocina', 15, 1],
  ['🧹', 'Barrer o aspirar', 20, 3],
  ['🧽', 'Limpiar el baño', 30, 4],
  ['🛒', 'Compra', 60, 5],
  ['🗑️', 'Basura y reciclaje', 10, 6],
  ['🧼', 'Limpieza general', 30, 7],
  ['👔', 'Planchar', 30, 8],
];
const DEFAULT_GROUPS = [
  ['🧺', 'Colada', 2, [
    ['🔘', 'Poner la lavadora', 5],
    ['👕', 'Tender', 10],
    ['🧦', 'Recoger y doblar la ropa', 20],
  ]],
];

export function openDb(file, { users = 'Persona 1,Persona 2' } = {}) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '🏠',
      default_min INTEGER NOT NULL DEFAULT 20,
      archived INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      start_ts INTEGER NOT NULL,
      end_ts INTEGER,
      note TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      deleted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entries_start ON entries(start_ts);
    CREATE INDEX IF NOT EXISTS entries_user ON entries(user_id, start_ts);
    CREATE TABLE IF NOT EXISTS entry_edits (
      id INTEGER PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES entries(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      at INTEGER NOT NULL,
      changes TEXT NOT NULL,
      reason TEXT NOT NULL
    );
  `);

  // Migraciones: bases de datos creadas con versiones anteriores.
  if (!db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === 'parent_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id)');
  }

  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    const names = users.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 2);
    while (names.length < 2) names.push(`Persona ${names.length + 1}`);
    names.forEach((name, i) =>
      db.prepare('INSERT INTO users (name, color) VALUES (?, ?)').run(name, COLORS[i]),
    );
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n === 0) {
    const insert = db.prepare('INSERT INTO tasks (emoji, name, default_min, sort, parent_id) VALUES (?, ?, ?, ?, ?)');
    for (const [emoji, name, min, sort] of DEFAULT_TASKS) insert.run(emoji, name, min, sort, null);
    for (const [emoji, name, sort, children] of DEFAULT_GROUPS) {
      const parent = Number(insert.run(emoji, name, 20, sort, null).lastInsertRowid);
      children.forEach(([e, n, min], i) => insert.run(e, n, min, i, parent));
    }
  }
  return db;
}
