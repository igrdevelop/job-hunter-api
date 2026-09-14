import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { UsersRepository } from './user.db';

/**
 * `aud` claim of the short-lived tokens minted by GET /auth/download-token.
 * Such a token ends up in URLs (browser history, proxy logs), so it must only
 * ever be accepted as `?dt=` on file-stream routes — never as a bearer token.
 */
export const DOWNLOAD_AUDIENCE = 'download';

/** Shape placed on `req.user` by both JwtStrategy and DownloadAuthGuard. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  email_verified: number;
}

export function hasDownloadAudience(payload: { aud?: unknown }): boolean {
  const aud = payload.aud;
  return Array.isArray(aud)
    ? aud.includes(DOWNLOAD_AUDIENCE)
    : aud === DOWNLOAD_AUDIENCE;
}

/**
 * Resolves a verified token's `sub` to the CURRENT database row. A token only
 * proves identity: a deleted or disabled account is rejected even while its
 * token is still unexpired, and role/email come from the DB, never from the
 * token's claims (a demoted admin must not keep admin rights for 7 days).
 */
export function resolveActiveUser(
  users: UsersRepository,
  sub: unknown,
): AuthenticatedUser {
  const user =
    typeof sub === 'string' && sub !== '' ? users.findById(sub) : undefined;
  if (!user || user.disabled) {
    // Same response for "never existed", "deleted" and "disabled" — nothing
    // to distinguish from the caller's side.
    throw new UnauthorizedException();
  }
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    email_verified: user.email_verified,
  };
}

/** Admins bypass the email-verified gate (e.g. the seeded owner). */
export function assertEmailVerified(user: {
  role?: string;
  email_verified?: number;
}): void {
  if (user.role !== 'admin' && !user.email_verified) {
    throw new ForbiddenException('Email not verified');
  }
}
