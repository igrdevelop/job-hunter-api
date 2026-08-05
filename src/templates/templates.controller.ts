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
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createReadStream } from 'fs';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { extname } from 'path';
import { TemplatesService } from './templates.service';
import type { TemplateCategory } from './templates.service';

@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@Query('category') category?: string) {
    return this.templates.list(category as TemplateCategory | undefined);
  }

  @Get(':id/content')
  content(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    const template = this.templates.get(id);
    const path = this.templates.resolveContent(id);
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
    @UploadedFile() file: Express.Multer.File,
    @Body('name') name: string,
    @Body('category') category: string,
    @Body('description') description?: string,
  ) {
    return this.templates.create(file, {
      name,
      category: category as TemplateCategory,
      description,
    });
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    this.templates.remove(id);
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
