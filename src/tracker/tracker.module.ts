import { Module } from '@nestjs/common';
import { TrackerService } from './tracker.service';

@Module({
  providers: [TrackerService],
  exports: [TrackerService],
})
export class TrackerModule {}
