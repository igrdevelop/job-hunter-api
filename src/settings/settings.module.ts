import { Module } from '@nestjs/common';
import { TrackerModule } from '../tracker/tracker.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { UserSettingsService } from './user-settings.service';

@Module({
  imports: [TrackerModule],
  controllers: [SettingsController],
  providers: [SettingsService, UserSettingsService],
})
export class SettingsModule {}
