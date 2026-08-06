import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

interface DownloadTokenPayload {
  sub: string;
  email: string;
  role: string;
  aud?: string;
}

/**
 * Used on file-stream GET endpoints. Accepts:
 *   1. Standard bearer JWT in Authorization header.
 *   2. ?dt= query param containing a 5-min download-audience JWT.
 */
@Injectable()
export class DownloadAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { user?: unknown }>();
    const secret = this.config.get<string>('jwt.secret')!;

    const dt = req.query['dt'] as string | undefined;
    if (dt) {
      const payload = this.verifyOrThrow(dt, secret);
      if (payload.aud !== 'download') {
        throw new UnauthorizedException('Invalid download token');
      }
      req.user = { id: payload.sub, email: payload.email, role: payload.role };
      return true;
    }

    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const payload = this.verifyOrThrow(token, secret);
      req.user = { id: payload.sub, email: payload.email, role: payload.role };
      return true;
    }

    throw new UnauthorizedException();
  }

  private verifyOrThrow(token: string, secret: string): DownloadTokenPayload {
    try {
      return this.jwtService.verify<DownloadTokenPayload>(token, { secret });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
