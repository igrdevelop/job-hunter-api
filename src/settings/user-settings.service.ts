import { BadRequestException, Injectable } from '@nestjs/common';
import { TrackerService } from '../tracker/tracker.service';

// Keys the user is allowed to read and write.
const USER_SETTINGS_WHITELIST = new Set([
  'AUTO_APPLY',
  'MAX_JOBS_PER_RUN',
  'APPLY_DELAY_SEC',
  'CANDIDATE_TRACKS',
  'CV_GDPR_CLAUSE',
  'TELEGRAM_SEND_DOCS',
  'hunting_enabled',
  // Source enable toggles
  'SOURCE_LINKEDIN',
  'SOURCE_PRACUJ',
  'SOURCE_JUSTJOINIT',
  'SOURCE_NOFLUFFJOBS',
  'SOURCE_THEPROTOCOL',
  'SOURCE_BULLDOGJOB',
  'SOURCE_SOLID_JOBS',
  'SOURCE_INHIRE',
]);

export type UserSettings = Record<string, string>;

@Injectable()
export class UserSettingsService {
  constructor(private readonly tracker: TrackerService) {}

  get(userId: string): UserSettings {
    const rows = this.tracker.db
      .prepare(`SELECT key, value FROM user_settings WHERE user_id = ?`)
      .all(userId) as { key: string; value: string }[];

    const result: UserSettings = {};
    for (const { key, value } of rows) {
      if (USER_SETTINGS_WHITELIST.has(key)) {
        result[key] = value;
      }
    }
    return result;
  }

  update(userId: string, patch: Record<string, string>): UserSettings {
    const invalid = Object.keys(patch).filter((k) => !USER_SETTINGS_WHITELIST.has(k));
    if (invalid.length) {
      throw new BadRequestException(`Unknown setting keys: ${invalid.join(', ')}`);
    }

    const upsert = this.tracker.db.prepare(`
      INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    const tx = this.tracker.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        upsert.run(userId, key, String(value));
      }
    });
    tx();

    return this.get(userId);
  }
}
