import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TrackerModule } from '../tracker/tracker.module';
import { PipelineCommandsService } from './pipeline-commands.service';
import { PipelineController } from './pipeline.controller';
import { PIPELINE_CLOCK, PipelineService } from './pipeline.service';

@Module({
  imports: [AuthModule, TrackerModule],
  controllers: [PipelineController],
  providers: [
    PipelineService,
    PipelineCommandsService,
    // Injectable clock: tests freeze it at the contract fixture's NOW.
    { provide: PIPELINE_CLOCK, useValue: () => new Date() },
  ],
})
export class PipelineModule {}
