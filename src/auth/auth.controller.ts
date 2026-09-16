import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { DOWNLOAD_AUDIENCE } from './authenticated-user';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';
import { Public } from './decorators/public.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';

interface AuthenticatedRequest extends Request {
  user: { id: string; email: string; role: string };
}

@UseGuards(ClientIpThrottlerGuard)
@Throttle({ default: { ttl: 60_000, limit: 30 } })
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto.email, dto.password);
  }

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  @Public()
  @Post('verify')
  async verify(@Body() dto: VerifyEmailDto) {
    await this.authService.verifyEmail(dto.token);
    return { ok: true };
  }

  @Public()
  @Post('resend')
  async resend(@Body() dto: ResendVerificationDto) {
    await this.authService.resendVerification(dto.email);
    return { ok: true };
  }

  @Get('download-token')
  downloadToken(@Req() req: AuthenticatedRequest) {
    const token = this.jwtService.sign(
      {
        sub: req.user.id,
        email: req.user.email,
        role: req.user.role,
        aud: DOWNLOAD_AUDIENCE,
      },
      { secret: this.config.get<string>('jwt.secret'), expiresIn: '5m' },
    );
    return { token };
  }

  @Get('me')
  me(@Req() req: AuthenticatedRequest) {
    const user = this.authService.findById(req.user.id);
    if (!user) {
      throw new NotFoundException();
    }
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      emailVerified: !!user.email_verified,
      isOwner: this.authService.isOwner(user.id),
    };
  }
}
