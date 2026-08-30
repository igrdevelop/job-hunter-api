import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ProfileService } from './profile.service';

@Controller('profile')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get()
  get(@CurrentUser() user: CurrentUserData) {
    return this.profile.get(user.id);
  }

  @Put()
  put(@CurrentUser() user: CurrentUserData, @Body() body: unknown) {
    return this.profile.put(user.id, body);
  }

  @Get('revisions')
  revisions(@CurrentUser() user: CurrentUserData) {
    return this.profile.listRevisions(user.id);
  }

  @Post('revisions/:rev/restore')
  @HttpCode(200)
  restore(@CurrentUser() user: CurrentUserData, @Param('rev') rev: string) {
    return this.profile.restore(user.id, Number(rev));
  }

  @Get('jobs/:id')
  getJob(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.profile.getJob(user.id, id);
  }
}
