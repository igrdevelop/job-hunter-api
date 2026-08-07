import { Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { TelegramService } from './telegram.service';

@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  @Post('link-code')
  linkCode(@CurrentUser() user: CurrentUserData) {
    return this.telegram.generateLinkCode(user.id);
  }

  @Get('status')
  status(@CurrentUser() user: CurrentUserData) {
    return this.telegram.getStatus(user.id);
  }
}
