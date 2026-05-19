import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db = null;

// ── Helpers ──────────────────────────────────────────────────────────

const normalizeEmail = (email) => email.trim().toLowerCase();

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

/**
 * Validate password against policy.
 * Returns null if valid, or error message string if invalid.
 */
export function validatePassword(password) {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters long';
  }
  if (!/[a-z]/.test(password)) {
    return 'Password must contain at least one lowercase letter';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must contain at least one uppercase letter';
  }
  if (!/\d/.test(password)) {
    return 'Password must contain at least one number';
  }
  return null;
}

const VALID_ROLES = ['interviewer', 'supervisor'];

// ── Initialization ──────────────────────────────────────────────────

/**
 * Initialize SQLite database.
 * Creates data/ directory and recruit.db if they don't exist.
 * Enables WAL mode for better concurrent read performance.
 * Seeds default users from environment variables on first run.
 */
export async function initDatabase() {
  // Create data directory next to src/
  const dataDir = path.resolve(__dirname, '../../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'recruit.db');
  db = new Database(dbPath);

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');

  // Create users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK(role IN ('interviewer', 'supervisor')),
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed default users from .env if not already present
  await seedDefaultUsers();

  console.log('Database initialized (SQLite WAL mode)');
}

/**
 * Seeds the default interviewer and supervisor from .env
 * if they don't already exist in the database.
 */
async function seedDefaultUsers() {
  const defaults = [
    {
      email: process.env.INTERVIEWER_EMAIL,
      password: process.env.INTERVIEWER_PASSWORD,
      name: 'Interviewer',
      role: 'interviewer',
    },
    {
      email: process.env.SUPERVISOR_EMAIL,
      password: process.env.SUPERVISOR_PASSWORD,
      name: 'Supervisor',
      role: 'supervisor',
    },
  ];

  for (const def of defaults) {
    if (!def.email || !def.password) continue;

    const normalized = normalizeEmail(def.email);
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
    if (existing) continue;

    const id = uuidv4();
    const passwordHash = await bcrypt.hash(def.password, 12);

    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, def.name, normalized, passwordHash, def.role);

    console.log(`  Seeded default ${def.role}: ${normalized}`);
  }
}

// ── User CRUD ───────────────────────────────────────────────────────

/**
 * Find a user by email. Returns user row or undefined.
 * Email is normalized before query.
 */
export function findUserByEmail(email) {
  const normalized = normalizeEmail(email);
  return db.prepare(
    'SELECT id, name, email, password_hash, role, is_active, created_at FROM users WHERE email = ? AND is_active = 1'
  ).get(normalized);
}

/**
 * Find a user by ID. Returns user row or undefined.
 */
export function findUserById(id) {
  return db.prepare(
    'SELECT id, name, email, role, is_active, created_at FROM users WHERE id = ? AND is_active = 1'
  ).get(id);
}

/**
 * Create a new user.
 * Validates inputs, normalizes email, hashes password, inserts into DB.
 * Returns { user } on success, or throws an error with a message property.
 */
export async function createUser({ name, email, password, role }) {
  // Validate name
  if (!name || name.trim().length < 2 || name.trim().length > 100) {
    throw Object.assign(new Error('Name must be between 2 and 100 characters'), { status: 400 });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const normalized = normalizeEmail(email);
  if (!emailRegex.test(normalized)) {
    throw Object.assign(new Error('Invalid email format'), { status: 400 });
  }

  // Validate password policy
  const passwordError = validatePassword(password);
  if (passwordError) {
    throw Object.assign(new Error(passwordError), { status: 400 });
  }

  // Validate role
  if (!VALID_ROLES.includes(role)) {
    throw Object.assign(new Error(`Role must be one of: ${VALID_ROLES.join(', ')}`), { status: 400 });
  }

  // Check duplicate email
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
  if (existing) {
    throw Object.assign(new Error('An account with this email already exists'), { status: 409 });
  }

  // Hash password and insert
  const id = uuidv4();
  const passwordHash = await bcrypt.hash(password, 12);

  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, role)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name.trim(), normalized, passwordHash, role);

  return {
    userId: id,
    name: name.trim(),
    email: normalized,
    role,
  };
}

/**
 * Get the raw database instance (for testing/debugging only).
 */
export function getDb() {
  return db;
}
