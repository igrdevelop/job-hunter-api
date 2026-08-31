import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { safeJoin } from '../files/safe-path';

@Injectable()
export class UserPathsService {
  private readonly root: string;

  constructor(private readonly config: ConfigService) {
    this.root = this.config.get<string>('users.root')!;
  }

  candidateDir(userId: string): string {
    return safeJoin(this.root, userId, 'candidate');
  }

  applicationsDir(userId: string): string {
    return safeJoin(this.root, userId, 'Applications');
  }

  templatesDir(userId: string): string {
    return safeJoin(this.root, userId, 'templates');
  }

  /** Raw resume uploads awaiting the bot's parse job — not user-browsable. */
  uploadsDir(userId: string): string {
    return safeJoin(this.root, userId, 'uploads');
  }

  /**
   * Dated preview-PDF runs — users/{id}/candidate/preview/<track>/<ts>/.
   * Written by the bot's `preview` job kind (docs/PROFILE_PAGE_TABS.md T1);
   * each run gets its own timestamped folder, never overwritten.
   */
  previewDir(userId: string): string {
    return safeJoin(this.root, userId, 'candidate', 'preview');
  }

  ensureUserDirs(userId: string): void {
    const dirs = [
      this.candidateDir(userId),
      this.applicationsDir(userId),
      this.templatesDir(userId),
    ];
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }
    const manifest = join(this.templatesDir(userId), 'manifest.json');
    if (!existsSync(manifest)) {
      writeFileSync(manifest, JSON.stringify({ templates: [] }, null, 2));
    }
  }
}
