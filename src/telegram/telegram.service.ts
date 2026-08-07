import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { TrackerService } from '../tracker/tracker.service';

@Injectable()
export class TelegramService {
  constructor(private readonly tracker: TrackerService) {}

  generateLinkCode(userId: string): { code: string; expiresAt: string } {
    const code = randomBytes(3).toString('hex').toUpperCase(); // 6-char hex
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    this.tracker.db
      .prepare(
        `INSERT OR REPLACE INTO telegram_link_codes (code, user_id, expires_at)
         VALUES (?, ?, ?)`,
      )
      .run(code, userId, expiresAt.toISOString());

    return { code, expiresAt: expiresAt.toISOString() };
  }

  getStatus(userId: string): { linked: boolean; chatId?: number } {
    const row = this.tracker.db
      .prepare(`SELECT chat_id FROM telegram_links WHERE user_id = ?`)
      .get(userId) as { chat_id: number } | undefined;

    if (!row) return { linked: false };
    return { linked: true, chatId: row.chat_id };
  }
}
