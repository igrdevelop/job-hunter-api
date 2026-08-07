import { Module } from '@nestjs/common';
import { TrackerModule } from '../tracker/tracker.module';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

@Module({
  imports: [TrackerModule],
  controllers: [TelegramController],
  providers: [TelegramService],
})
export class TelegramModule {}
