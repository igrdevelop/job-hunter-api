import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import {
  AuthenticatedUser,
  assertEmailVerified,
  hasDownloadAudience,
  resolveActiveUser,
} from '../authenticated-user';
import { UsersRepository } from '../user.db';

interface TokenPayload {
  sub: string;
  email: string;
  role: string;
  aud?: string | string[];
}

/**
 * Used on file-stream GET endpoints (which are `@Public()`, so the global
 * JwtAuthGuard does not run on them). Accepts:
 *   1. Standard bearer JWT in Authorization header.
 *   2. ?dt= query param containing a 5-min download-audience JWT.
 * Either way the token's subject is re-checked against the DB (exists, not
 * disabled, role from the row) and the same email-verified gate as the
 * global guard applies.
 */
@Injectable()
export class DownloadAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly users: UsersRepository,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();

    let payload: TokenPayload;
    const dt = req.query['dt'];
    if (dt) {
      if (typeof dt !== 'string') {
        throw new UnauthorizedException('Invalid download token');
      }
      payload = this.verifyOrThrow(dt);
      if (!hasDownloadAudience(payload)) {
        throw new UnauthorizedException('Invalid download token');
      }
    } else {
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        throw new UnauthorizedException();
      }
      payload = this.verifyOrThrow(authHeader.slice(7));
      // Same rule as JwtStrategy: a download token is only valid as ?dt=.
      if (hasDownloadAudience(payload)) {
        throw new UnauthorizedException(
          'Download tokens are only valid as ?dt=',
        );
      }
    }

    const user = resolveActiveUser(this.users, payload.sub);
    assertEmailVerified(user);
    req.user = user;
    return true;
  }

  private verifyOrThrow(token: string): TokenPayload {
    try {
      return this.jwtService.verify<TokenPayload>(token, {
        secret: this.config.get<string>('jwt.secret')!,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
