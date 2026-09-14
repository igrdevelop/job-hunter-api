import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import {
  AuthenticatedUser,
  hasDownloadAudience,
  resolveActiveUser,
} from '../authenticated-user';
import { UsersRepository } from '../user.db';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  aud?: string | string[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly users: UsersRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.secret')!,
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    // passport-jwt only checks `aud` when an audience option is configured.
    // Access tokens carry no `aud` (and existing ones must keep working), so
    // instead of requiring one, reject the download audience explicitly.
    if (hasDownloadAudience(payload)) {
      throw new UnauthorizedException('Download tokens are only valid as ?dt=');
    }
    return resolveActiveUser(this.users, payload.sub);
  }
}
