import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { FiltersService } from './filters.service';

@Controller('filters')
export class FiltersController {
  constructor(private readonly filters: FiltersService) {}

  @Get()
  get(@CurrentUser() user: CurrentUserData) {
    return this.filters.get(user.id);
  }

  @Put()
  put(@CurrentUser() user: CurrentUserData, @Body() body: unknown) {
    return this.filters.put(user.id, body);
  }
}
