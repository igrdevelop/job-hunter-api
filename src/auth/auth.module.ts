import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DownloadAuthGuard } from './guards/download-auth.guard';
import { JwtStrategy } from './strategies/jwt.strategy';
import { UsersRepository } from './user.db';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret'),
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, UsersRepository, JwtStrategy, DownloadAuthGuard],
  exports: [AuthService, JwtModule, DownloadAuthGuard],
})
export class AuthModule {}
