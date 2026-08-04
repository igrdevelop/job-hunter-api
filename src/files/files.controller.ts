import { Controller, Get, Param, Res, StreamableFile } from '@nestjs/common';
import { createReadStream } from 'fs';
import type { Response } from 'express';
import { FilesService } from './files.service';

@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get()
  listDates() {
    return this.files.listDates();
  }

  @Get(':date')
  listCompanies(@Param('date') date: string) {
    return this.files.listCompanies(date);
  }

  @Get(':date/:company')
  listFiles(@Param('date') date: string, @Param('company') company: string) {
    return this.files.listFiles(date, company);
  }

  @Get(':date/:company/:file')
  getFile(
    @Param('date') date: string,
    @Param('company') company: string,
    @Param('file') file: string,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    const { path, contentType, inline } = this.files.resolveFile(
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
