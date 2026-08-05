import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AnalyticsModule } from './analytics/analytics.module';
import { ApplicationsModule } from './applications/applications.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt.guard';
import configuration from './config/configuration';
import { FilesModule } from './files/files.module';
import { GeneratedModule } from './generated/generated.module';
import { HealthModule } from './health/health.module';
import { SettingsModule } from './settings/settings.module';
import { TemplatesModule } from './templates/templates.module';

@Module({
  imports: [
    ConfigModule.forRoot({ load: [configuration], isGlobal: true }),
    AuthModule,
    HealthModule,
    ApplicationsModule,
    FilesModule,
    GeneratedModule,
    TemplatesModule,
    AnalyticsModule,
    SettingsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
