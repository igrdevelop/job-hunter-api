import { Module } from '@nestjs/common';
import { GeneratedController } from './generated.controller';
import { GeneratedService } from './generated.service';

@Module({
  controllers: [GeneratedController],
  providers: [GeneratedService],
})
export class GeneratedModule {}
