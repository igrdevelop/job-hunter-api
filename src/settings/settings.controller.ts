import { Controller, Get } from '@nestjs/common';
import { SettingsService } from './settings.service';
import type { SettingsResponse } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  getAll(): SettingsResponse {
    return this.settings.getAll();
  }
}
