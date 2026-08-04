import { Controller, Get, Query } from '@nestjs/common';
import { FunnelQueryDto } from '../tracker/dto/funnel-query.dto';
import { AnalyticsService } from './analytics.service';
import { TimelineQueryDto } from './dto/timeline-query.dto';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('funnel')
  funnel(@Query() query: FunnelQueryDto) {
    return this.analytics.getFunnel(query.days);
  }

  @Get('sources')
  sources(@Query() query: FunnelQueryDto) {
    return this.analytics.getPerSource(query.days);
  }

  @Get('cost')
  cost(@Query() query: FunnelQueryDto) {
    return this.analytics.getCostSummary(query.days);
  }

  @Get('timeline')
  timeline(@Query() query: TimelineQueryDto) {
    return this.analytics.getTimeline(query.days);
  }
}
