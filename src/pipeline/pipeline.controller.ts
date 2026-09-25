import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { CreateCommandDto } from './dto/create-command.dto';
import { SnapshotQueryDto } from './dto/snapshot-query.dto';
import { PipelineCommandsService } from './pipeline-commands.service';
import { PipelineService } from './pipeline.service';

// JWT via the global JwtAuthGuard, like every other /api/* controller. The
// snapshot has no owner-only gate (docs/PIPELINE_VIZ_PLAN.md open question
// 4): any linked user gets their own apply/result tiers plus the shared hunt
// tier. The commands act on the one shared bot, so they are owner-only.
@Controller('pipeline')
export class PipelineController {
  constructor(
    private readonly pipeline: PipelineService,
    private readonly commands: PipelineCommandsService,
    private readonly auth: AuthService,
  ) {}

  @Get('snapshot')
  snapshot(
    @CurrentUser() user: CurrentUserData,
    @Query() query: SnapshotQueryDto,
  ) {
    return this.pipeline.getSnapshot(user.id, query.days);
  }

  /** Queue a hunt / retry_failed / check_expired for the bot → 201 {id}. */
  @Post('commands')
  createCommand(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateCommandDto,
  ) {
    this.requireOwner(user);
    return this.commands.create(user.id, dto);
  }

  @Get('commands/:id')
  getCommand(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    this.requireOwner(user);
    return this.commands.get(id);
  }

  private requireOwner(user: CurrentUserData): void {
    if (!this.auth.isOwner(user.id)) {
      throw new ForbiddenException('owner only');
    }
  }
}
