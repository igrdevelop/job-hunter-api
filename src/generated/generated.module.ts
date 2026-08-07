import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { GeneratedController } from './generated.controller';
import { GeneratedService } from './generated.service';

@Module({
  imports: [AuthModule, UsersModule],
  controllers: [GeneratedController],
  providers: [GeneratedService],
})
export class GeneratedModule {}
