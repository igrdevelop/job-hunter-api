import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { runMigrations } from '../db/migrations';

export interface User {
  id: string;
  email: string;
  password: string;
  role: string;
  email_verified: number;
  disabled: number;
  created_at: string;
}

@Injectable()
export class UsersRepository {
  private db: Database.Database;

  constructor(private readonly config: ConfigService) {
    const dbPath = this.config.get<string>('app.dbPath')!;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    runMigrations(this.db);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM users').get() as {
      c: number;
    };
    return row.c;
  }

  findByEmail(email: string): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
      | User
      | undefined;
  }

  findById(id: string): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | User
      | undefined;
  }

  create(email: string, hashedPassword: string): User {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO users (id, email, password) VALUES (?, ?, ?)')
      .run(id, email, hashedPassword);
    return this.findById(id)!;
  }

  createAdmin(email: string, hashedPassword: string): User {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO users (id, email, password, role, email_verified) VALUES (?, ?, ?, 'admin', 1)`,
      )
      .run(id, email, hashedPassword);
    return this.findById(id)!;
  }

  setEmailVerified(id: string): void {
    this.db
      .prepare(`UPDATE users SET email_verified = 1 WHERE id = ?`)
      .run(id);
  }

  setDisabled(id: string, disabled: boolean): void {
    this.db
      .prepare(`UPDATE users SET disabled = ? WHERE id = ?`)
      .run(disabled ? 1 : 0, id);
  }

  deleteById(id: string): void {
    this.db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  }

  findAll(): User[] {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as User[];
  }

  // Email verification token helpers.
  createVerificationToken(userId: string, token: string, expiresAt: Date): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO email_verification_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`,
      )
      .run(token, userId, expiresAt.toISOString());
  }

  consumeVerificationToken(token: string): string | null {
    const row = this.db
      .prepare(`SELECT user_id, expires_at FROM email_verification_tokens WHERE token = ?`)
      .get(token) as { user_id: string; expires_at: string } | undefined;
    if (!row) return null;
    this.db.prepare(`DELETE FROM email_verification_tokens WHERE token = ?`).run(token);
    if (new Date(row.expires_at) < new Date()) return null;
    return row.user_id;
  }

  deleteVerificationTokensByUser(userId: string): void {
    this.db
      .prepare(`DELETE FROM email_verification_tokens WHERE user_id = ?`)
      .run(userId);
  }
}
