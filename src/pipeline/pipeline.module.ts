import { Module } from '@nestjs/common';
import { PipelineController } from './pipeline.controller';
import { PIPELINE_CLOCK, PipelineService } from './pipeline.service';

@Module({
  controllers: [PipelineController],
  providers: [
    PipelineService,
    // Injectable clock: tests freeze it at the contract fixture's NOW.
    { provide: PIPELINE_CLOCK, useValue: () => new Date() },
  ],
})
export class PipelineModule {}
