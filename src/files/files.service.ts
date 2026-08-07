import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  Stats,
  writeFileSync,
} from 'fs';
import { basename, extname, join } from 'path';
import { UserPathsService } from '../users/user-paths.service';
import { FileInfo, FolderInfo } from './dto/folder-info.dto';
import { safeJoin } from './safe-path';

export type CandidateEntry = FolderInfo | FileInfo;

const KNOWN_TYPES = new Set([
  'pdf',
  'docx',
  'txt',
  'json',
  'md',
  'yaml',
  'yml',
]);

const CONTENT_TYPES: Record<string, { contentType: string; inline: boolean }> = {
  '.pdf': { contentType: 'application/pdf', inline: true },
  '.docx': {
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    inline: false,
  },
  '.txt': { contentType: 'text/plain; charset=utf-8', inline: true },
  '.md': { contentType: 'text/markdown; charset=utf-8', inline: true },
  '.json': { contentType: 'application/json', inline: true },
  '.yaml': { contentType: 'text/yaml; charset=utf-8', inline: true },
  '.yml': { contentType: 'text/yaml; charset=utf-8', inline: true },
};
const DEFAULT_CONTENT_TYPE = {
  contentType: 'application/octet-stream',
  inline: false,
};

/** Browse + upload under a user's candidate/ folder. */
@Injectable()
export class FilesService {
  constructor(private readonly userPaths: UserPathsService) {}

  list(userId: string, relativePath = ''): CandidateEntry[] {
    const root = this.userPaths.candidateDir(userId);
    const dir = this.resolveDir(root, relativePath);
    return this.listDir(dir).map((e) =>
      e.isDirectory
        ? this.toFolderInfo(e)
        : {
            name: e.name,
            size: e.stat.size,
            type: this.fileType(e.name),
            modified: e.stat.mtime.toISOString(),
          },
    );
  }

  resolveFile(
    userId: string,
    relativePath: string,
  ): { path: string; contentType: string; inline: boolean; fileName: string } {
    const root = this.userPaths.candidateDir(userId);
    const path = this.resolveExisting(root, relativePath);
    let stat: Stats;
    try {
      stat = statSync(path);
    } catch {
      throw new NotFoundException('File not found');
    }
    if (!stat.isFile()) {
      throw new NotFoundException('File not found');
    }
    const fileName = basename(path);
    const { contentType, inline } =
      CONTENT_TYPES[extname(fileName).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
    return { path, contentType, inline, fileName };
  }

  isDirectory(userId: string, relativePath: string): boolean {
    if (!relativePath) return true;
    const root = this.userPaths.candidateDir(userId);
    try {
      return statSync(this.resolveExisting(root, relativePath)).isDirectory();
    } catch {
      return false;
    }
  }

  saveUpload(
    userId: string,
    file: Express.Multer.File,
    relativeDir = '',
  ): FileInfo {
    if (!file?.buffer?.length && !file?.size) {
      throw new BadRequestException('Empty file');
    }
    const safeName = basename(file.originalname).replace(/[^\w.\- ()[\]]+/g, '_');
    if (!safeName || safeName.startsWith('.')) {
      throw new BadRequestException('Invalid file name');
    }

    const root = this.userPaths.candidateDir(userId);
    const dir = this.resolveDir(root, relativeDir, true);
    mkdirSync(dir, { recursive: true });
    const dest = safeJoin(dir, safeName);
    writeFileSync(dest, file.buffer);

    const stat = statSync(dest);
    return {
      name: safeName,
      size: stat.size,
      type: this.fileType(safeName),
      modified: stat.mtime.toISOString(),
    };
  }

  private resolveDir(root: string, relativePath: string, create = false): string {
    const segments = this.splitPath(relativePath);
    const dir = segments.length ? safeJoin(root, ...segments) : root;
    if (create) return dir;
    if (!existsSync(dir)) {
      throw new NotFoundException('Folder not found');
    }
    if (!statSync(dir).isDirectory()) {
      throw new BadRequestException('Not a folder');
    }
    return dir;
  }

  private resolveExisting(root: string, relativePath: string): string {
    const segments = this.splitPath(relativePath);
    if (!segments.length) {
      throw new BadRequestException('Invalid path');
    }
    return safeJoin(root, ...segments);
  }

  private splitPath(relativePath: string): string[] {
    return relativePath
      .replace(/\\/g, '/')
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private listDir(dirPath: string) {
    let names: string[];
    try {
      names = readdirSync(dirPath);
    } catch {
      return [];
    }
    return names
      .filter((name) => !name.startsWith('.'))
      .map((name) => {
        const fullPath = join(dirPath, name);
        const stat = statSync(fullPath);
        return { name, fullPath, isDirectory: stat.isDirectory(), stat };
      });
  }

  private toFolderInfo(entry: {
    name: string;
    fullPath: string;
    stat: Stats;
  }): FolderInfo {
    let itemCount = 0;
    try {
      itemCount = readdirSync(entry.fullPath).filter(
        (name) => !name.startsWith('.'),
      ).length;
    } catch {
      itemCount = 0;
    }
    return {
      name: entry.name,
      itemCount,
      modified: entry.stat.mtime.toISOString(),
    };
  }

  private fileType(name: string): string {
    const ext = extname(name).toLowerCase().replace('.', '');
    if (ext === 'md') return 'txt';
    if (ext === 'yaml' || ext === 'yml') return 'txt';
    return KNOWN_TYPES.has(ext) ? ext : 'other';
  }
}
