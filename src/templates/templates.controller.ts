import {
  Body,
  Controller,
  Delete,
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
import { extname } from 'path';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { DownloadAuthGuard } from '../auth/guards/download-auth.guard';
import { TemplatesService } from './templates.service';
import type { TemplateCategory } from './templates.service';

@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserData, @Query('category') category?: string) {
    return this.templates.list(user.id, category as TemplateCategory | undefined);
  }

  @Public()
  @UseGuards(DownloadAuthGuard)
  @Get(':id/content')
  content(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    const template = this.templates.get(user.id, id);
    const path = this.templates.resolveContent(user.id, id);
    const inline = ['.pdf', '.txt', '.md', '.json', '.yaml', '.yml'].includes(
      extname(template.fileName).toLowerCase(),
    );
    res.set({
      'Content-Type': contentTypeFor(template.fileName),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${template.name.replace(/"/g, '')}${extname(template.fileName)}"`,
    });
    return new StreamableFile(createReadStream(path));
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  upload(
    @CurrentUser() user: CurrentUserData,
    @UploadedFile() file: Express.Multer.File,
    @Body('name') name: string,
    @Body('category') category: string,
    @Body('description') description?: string,
  ) {
    return this.templates.create(user.id, file, {
      name,
      category: category as TemplateCategory,
      description,
    });
  }

  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    this.templates.remove(user.id, id);
    return { ok: true };
  }
}

function contentTypeFor(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case '.pdf':
      return 'application/pdf';
    case '.json':
      return 'application/json';
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.yaml':
    case '.yml':
      return 'text/yaml; charset=utf-8';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default:
      return 'application/octet-stream';
  }
}
