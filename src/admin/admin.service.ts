import { Injectable } from '@nestjs/common';
import { rmSync } from 'fs';
import { dirname } from 'path';
import { UsersRepository } from '../auth/user.db';
import { ProfileService } from '../profile/profile.service';
import { UserPathsService } from '../users/user-paths.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly users: UsersRepository,
    private readonly userPaths: UserPathsService,
    private readonly profile: ProfileService,
  ) {}

  listUsers() {
    return this.users.findAll().map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      emailVerified: !!u.email_verified,
      disabled: !!u.disabled,
      createdAt: u.created_at,
    }));
  }

  updateUser(id: string, patch: { disabled?: boolean }) {
    const user = this.users.findById(id);
    if (!user) return null;
    if (patch.disabled !== undefined) {
      this.users.setDisabled(id, patch.disabled);
    }
    const updated = this.users.findById(id)!;
    return {
      id: updated.id,
      email: updated.email,
      role: updated.role,
      emailVerified: !!updated.email_verified,
      disabled: !!updated.disabled,
    };
  }

  deleteUser(id: string): boolean {
    const user = this.users.findById(id);
    if (!user) return false;
    // Right-to-erasure (docs/RESUME_PROFILE_STORE.md): profile/revisions
    // (app.sqlite) and profile_jobs (tracker.db) rows first — the uploads/
    // directory dies below with the rest of users/{id}/, same as
    // candidate/ and Applications/ today.
    this.profile.eraseUser(id);
    this.users.deleteById(id);
    // Remove user directory tree (best-effort).
    try {
      const userRoot = dirname(this.userPaths.candidateDir(id));
      rmSync(userRoot, { recursive: true, force: true });
    } catch {
      // Non-fatal: dir may not exist yet.
    }
    return true;
  }
}
