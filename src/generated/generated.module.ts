import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GeneratedController } from './generated.controller';
import { GeneratedService } from './generated.service';

@Module({
  imports: [AuthModule],
  controllers: [GeneratedController],
  providers: [GeneratedService],
})
export class GeneratedModule {}
