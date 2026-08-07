import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { FunnelQueryDto } from '../tracker/dto/funnel-query.dto';
import { QueryApplicationsDto } from '../tracker/dto/query.dto';
import { UpdateApplicationDto } from '../tracker/dto/update.dto';
import { TrackerService } from '../tracker/tracker.service';

@Controller('applications')
export class ApplicationsController {
  constructor(private readonly tracker: TrackerService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserData, @Query() query: QueryApplicationsDto) {
    return this.tracker.getApplications(user.id, query);
  }

  @Get('stats')
  stats(@CurrentUser() user: CurrentUserData) {
    return this.tracker.getStats(user.id);
  }

  @Get('funnel')
  funnel(@CurrentUser() user: CurrentUserData, @Query() query: FunnelQueryDto) {
    return this.tracker.getFunnel(user.id, query.days);
  }

  @Get(':id')
  getOne(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    const application = this.tracker.getApplicationById(user.id, id);
    if (!application) {
      throw new NotFoundException(`Application ${id} not found`);
    }
    return application;
  }

  @Patch(':id')
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: UpdateApplicationDto,
  ) {
    if (dto.sent !== undefined) {
      this.tracker.updateSent(user.id, id, dto.sent);
    }
    if (dto.toLearn !== undefined) {
      this.tracker.updateToLearn(user.id, id, dto.toLearn);
    }
    return this.tracker.getApplicationById(user.id, id);
  }
}
