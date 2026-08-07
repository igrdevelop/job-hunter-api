import { Module } from '@nestjs/common';
import { UserPathsService } from './user-paths.service';

@Module({
  providers: [UserPathsService],
  exports: [UserPathsService],
})
export class UsersModule {}
