import { Module } from '@nestjs/common';
import { TrackerModule } from '../tracker/tracker.module';
import { ProfilesRepository } from './profile.db';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

@Module({
  imports: [TrackerModule],
  controllers: [ProfileController],
  providers: [ProfileService, ProfilesRepository],
})
export class ProfileModule {}
