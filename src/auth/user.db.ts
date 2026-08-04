import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export interface User {
  id: string;
  email: string;
  password: string;
  created_at: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`;

@Injectable()
export class UsersRepository {
  private db: Database.Database;

  constructor(private readonly config: ConfigService) {
    const dbPath = this.config.get<string>('app.dbPath')!;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
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
}
