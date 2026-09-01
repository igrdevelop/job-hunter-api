import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TrackerModule } from '../tracker/tracker.module';
import { UsersModule } from '../users/users.module';
import { ProfilesRepository } from './profile.db';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { UserThrottlerGuard } from './user-throttler.guard';

@Module({
  imports: [AuthModule, TrackerModule, UsersModule],
  controllers: [ProfileController],
  providers: [ProfileService, ProfilesRepository, UserThrottlerGuard],
  exports: [ProfileService],
})
export class ProfileModule {}
