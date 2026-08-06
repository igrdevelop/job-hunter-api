import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createReadStream } from 'fs';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { Public } from '../auth/decorators/public.decorator';
import { DownloadAuthGuard } from '../auth/guards/download-auth.guard';
import { FilesService } from './files.service';

@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get()
  listRoot() {
    return this.files.list('');
  }

  @Public()
  @UseGuards(DownloadAuthGuard)
  @Get('{*path}')
  listOrGet(
    @Param('path') path: string | string[],
    @Res({ passthrough: true }) res: Response,
  ): unknown {
    const relativePath = normalizeCatchAll(path);
    if (this.files.isDirectory(relativePath)) {
      return this.files.list(relativePath);
    }

    const { path: abs, contentType, inline, fileName } =
      this.files.resolveFile(relativePath);
    const safeName = fileName.replace(/"/g, '');
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
    });
    return new StreamableFile(createReadStream(abs));
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  uploadRoot(
    @UploadedFile() file: Express.Multer.File,
    @Query('path') path?: string,
  ) {
    return this.files.saveUpload(file, path ?? '');
  }

  @Post('{*path}')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  uploadInto(
    @Param('path') path: string | string[],
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.files.saveUpload(file, normalizeCatchAll(path));
  }
}

function normalizeCatchAll(path: string | string[]): string {
  if (Array.isArray(path)) return path.join('/');
  return (path ?? '').replace(/\\/g, '/');
}
