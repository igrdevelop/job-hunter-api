import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ApplicationsModule } from './applications/applications.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt.guard';
import configuration from './config/configuration';
import { FilesModule } from './files/files.module';
import { MailModule } from './mail/mail.module';
import { GeneratedModule } from './generated/generated.module';
import { HealthModule } from './health/health.module';
import { SettingsModule } from './settings/settings.module';
import { TelegramModule } from './telegram/telegram.module';
import { TemplatesModule } from './templates/templates.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ load: [configuration], isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }]),
    AuthModule,
    AdminModule,
    HealthModule,
    ApplicationsModule,
    FilesModule,
    GeneratedModule,
    TemplatesModule,
    AnalyticsModule,
    SettingsModule,
    TelegramModule,
    UsersModule,
    MailModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
