import { Controller, Get, Param, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { createReadStream } from 'fs';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { DownloadAuthGuard } from '../auth/guards/download-auth.guard';
import { GeneratedService } from './generated.service';

@Controller('generated')
export class GeneratedController {
  constructor(private readonly generated: GeneratedService) {}

  @Get()
  listDates() {
    return this.generated.listDates();
  }

  @Get(':date')
  listCompanies(@Param('date') date: string) {
    return this.generated.listCompanies(date);
  }

  @Get(':date/:company')
  listFiles(@Param('date') date: string, @Param('company') company: string) {
    return this.generated.listFiles(date, company);
  }

  @Public()
  @UseGuards(DownloadAuthGuard)
  @Get(':date/:company/:file')
  getFile(
    @Param('date') date: string,
    @Param('company') company: string,
    @Param('file') file: string,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    const { path, contentType, inline } = this.generated.resolveFile(
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
