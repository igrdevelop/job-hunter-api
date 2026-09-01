import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { createReadStream } from 'fs';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { DownloadAuthGuard } from '../auth/guards/download-auth.guard';
import {
  ALLOWED_UPLOAD_EXTENSIONS,
  extensionOf,
  MAX_UPLOAD_BYTES,
} from './profile-upload';
import { ProfileService } from './profile.service';
import { UserThrottlerGuard } from './user-throttler.guard';

@Controller('profile')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get()
  get(@CurrentUser() user: CurrentUserData) {
    return this.profile.get(user.id);
  }

  @Put()
  put(@CurrentUser() user: CurrentUserData, @Body() body: unknown) {
    return this.profile.put(user.id, body);
  }

  @Get('revisions')
  revisions(@CurrentUser() user: CurrentUserData) {
    return this.profile.listRevisions(user.id);
  }

  @Post('revisions/:rev/restore')
  @HttpCode(200)
  restore(@CurrentUser() user: CurrentUserData, @Param('rev') rev: string) {
    return this.profile.restore(user.id, Number(rev));
  }

  @Get('jobs/:id')
  getJob(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.profile.getJob(user.id, id);
  }

  @Post('uploads')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { ttl: 60 * 60 * 1000, limit: 10 } })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES },
      fileFilter: (_req, file, cb) => {
        const ext = extensionOf(file.originalname);
        if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
          cb(
            new BadRequestException(`Unsupported file type: .${ext || '?'}`),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  upload(
    @CurrentUser() user: CurrentUserData,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.profile.uploadResume(user.id, file);
  }

  @Post('preview')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { ttl: 60 * 60 * 1000, limit: 10 } })
  preview(@CurrentUser() user: CurrentUserData, @Body() body: unknown) {
    return this.profile.preview(user.id, body);
  }

  @Get('previews')
  listPreviews(@CurrentUser() user: CurrentUserData) {
    return this.profile.listPreviews(user.id);
  }

  // File-stream route: same pattern as FilesController/GeneratedController —
  // skip the global JWT guard and accept either a bearer JWT or a ?dt=
  // download token, since window.open cannot carry an Authorization header.
  @Public()
  @UseGuards(DownloadAuthGuard)
  @Get('previews/:track/:ts/:file')
  getPreviewFile(
    @CurrentUser() user: CurrentUserData,
    @Param('track') track: string,
    @Param('ts') ts: string,
    @Param('file') file: string,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    const { path, contentType, inline } = this.profile.resolvePreviewFile(
      user.id,
      track,
      ts,
      file,
    );
    const safeName = file.replace(/"/g, '');
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
    });
    return new StreamableFile(createReadStream(path));
  }

  @Get('uploads')
  listUploads(@CurrentUser() user: CurrentUserData) {
    return this.profile.listUploads(user.id);
  }

  @Get('files')
  listFiles(@CurrentUser() user: CurrentUserData) {
    return this.profile.listCandidateFiles(user.id);
  }

  @Get('files/:name')
  getFile(
    @CurrentUser() user: CurrentUserData,
    @Param('name') name: string,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    const { path, contentType } = this.profile.getCandidateFile(user.id, name);
    const safeName = name.replace(/"/g, '');
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${safeName}"`,
    });
    return new StreamableFile(createReadStream(path));
  }
}
