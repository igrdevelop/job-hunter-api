import { Module } from '@nestjs/common';
import { TrackerModule } from '../tracker/tracker.module';
import { ApplicationsController } from './applications.controller';

@Module({
  imports: [TrackerModule],
  controllers: [ApplicationsController],
})
export class ApplicationsModule {}
