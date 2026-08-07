import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SettingsService } from './settings.service';
import { UserSettingsService } from './user-settings.service';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly userSettings: UserSettingsService,
  ) {}

  @Get()
  getMySettings(@CurrentUser() user: CurrentUserData) {
    return this.userSettings.get(user.id);
  }

  @Put()
  updateMySettings(
    @CurrentUser() user: CurrentUserData,
    @Body() body: Record<string, string>,
  ) {
    return this.userSettings.update(user.id, body);
  }

  @Roles('admin')
  @UseGuards(RolesGuard)
  @Get('global')
  getGlobal() {
    return this.settings.getAll();
  }
}
