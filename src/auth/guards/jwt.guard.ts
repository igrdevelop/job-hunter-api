import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }

  handleRequest<T extends { email_verified?: number; role?: string }>(
    err: unknown,
    user: T,
    info: unknown,
    context: ExecutionContext,
  ): T {
    const result = super.handleRequest(err, user, info, context) as T;
    // Admins bypass the email-verified gate (e.g. seeded owner).
    if (result?.role !== 'admin' && !result?.email_verified) {
      throw new ForbiddenException('Email not verified');
    }
    return result;
  }
}
