import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { FunnelQueryDto } from '../tracker/dto/funnel-query.dto';
import { QueryApplicationsDto } from '../tracker/dto/query.dto';
import { UpdateApplicationDto } from '../tracker/dto/update.dto';
import { TrackerService } from '../tracker/tracker.service';

@Controller('applications')
export class ApplicationsController {
  constructor(private readonly tracker: TrackerService) {}

  @Get()
  list(@Query() query: QueryApplicationsDto) {
    return this.tracker.getApplications(query);
  }

  @Get('stats')
  stats() {
    return this.tracker.getStats();
  }

  @Get('funnel')
  funnel(@Query() query: FunnelQueryDto) {
    return this.tracker.getFunnel(query.days);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    const application = this.tracker.getApplicationById(id);
    if (!application) {
      throw new NotFoundException(`Application ${id} not found`);
    }
    return application;
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateApplicationDto) {
    if (dto.sent !== undefined) {
      this.tracker.updateSent(id, dto.sent);
    }
    if (dto.to_learn !== undefined) {
      this.tracker.updateToLearn(id, dto.to_learn);
    }
    if (dto.reapplication !== undefined) {
      this.tracker.updateReapplication(id, dto.reapplication);
    }
    return this.tracker.getApplicationById(id);
  }
}
