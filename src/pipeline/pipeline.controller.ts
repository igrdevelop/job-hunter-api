import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { SnapshotQueryDto } from './dto/snapshot-query.dto';
import { PipelineService } from './pipeline.service';

// JWT via the global JwtAuthGuard, like every other /api/* controller. No
// owner-only gate (docs/PIPELINE_VIZ_PLAN.md open question 4): any linked
// user gets their own apply/result tiers plus the shared hunt tier.
@Controller('pipeline')
export class PipelineController {
  constructor(private readonly pipeline: PipelineService) {}

  @Get('snapshot')
  snapshot(
    @CurrentUser() user: CurrentUserData,
    @Query() query: SnapshotQueryDto,
  ) {
    return this.pipeline.getSnapshot(user.id, query.days);
  }
}
