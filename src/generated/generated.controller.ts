import { Controller, Get, Param, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { createReadStream } from 'fs';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { DownloadAuthGuard } from '../auth/guards/download-auth.guard';
import { GeneratedService } from './generated.service';

@Controller('generated')
export class GeneratedController {
  constructor(private readonly generated: GeneratedService) {}

  @Get()
  listDates(@CurrentUser() user: CurrentUserData) {
    return this.generated.listDates(user.id);
  }

  @Get(':date')
  listCompanies(@CurrentUser() user: CurrentUserData, @Param('date') date: string) {
    return this.generated.listCompanies(user.id, date);
  }

  @Get(':date/:company')
  listFiles(
    @CurrentUser() user: CurrentUserData,
    @Param('date') date: string,
    @Param('company') company: string,
  ) {
    return this.generated.listFiles(user.id, date, company);
  }

  @Public()
  @UseGuards(DownloadAuthGuard)
  @Get(':date/:company/:file')
  getFile(
    @CurrentUser() user: CurrentUserData,
    @Param('date') date: string,
    @Param('company') company: string,
    @Param('file') file: string,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    const { path, contentType, inline } = this.generated.resolveFile(
      user.id,
      date,
      company,
      file,
    );
    const safeName = file.replace(/"/g, '');
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
    });
    return new StreamableFile(createReadStream(path));
  }
}
