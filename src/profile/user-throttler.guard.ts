import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Throttles per authenticated user rather than per IP (AuthController's
 * default) — resume uploads are JWT-scoped already, and several users
 * behind the same NAT/proxy shouldn't share one bucket.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { id?: string } | undefined;
    return Promise.resolve(user?.id ?? (req.ip as string));
  }
}
