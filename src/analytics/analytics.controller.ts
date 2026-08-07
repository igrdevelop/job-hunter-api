import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { FunnelQueryDto } from '../tracker/dto/funnel-query.dto';
import { AnalyticsService } from './analytics.service';
import { TimelineQueryDto } from './dto/timeline-query.dto';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('funnel')
  funnel(@CurrentUser() user: CurrentUserData, @Query() query: FunnelQueryDto) {
    return this.analytics.getFunnel(user.id, query.days);
  }

  @Get('sources')
  sources(@CurrentUser() user: CurrentUserData, @Query() query: FunnelQueryDto) {
    return this.analytics.getPerSource(user.id, query.days);
  }

  @Get('cost')
  cost(@CurrentUser() user: CurrentUserData, @Query() query: FunnelQueryDto) {
    return this.analytics.getCostSummary(user.id, query.days);
  }

  @Get('timeline')
  timeline(@CurrentUser() user: CurrentUserData, @Query() query: TimelineQueryDto) {
    return this.analytics.getTimeline(user.id, query.days);
  }
}
