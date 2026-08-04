import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readdirSync, statSync, Stats } from 'fs';
import { extname, join } from 'path';
import { FileInfo, FolderInfo } from '../files/dto/folder-info.dto';
import { safeJoin } from '../files/safe-path';

interface DirEntry {
  name: string;
  fullPath: string;
  isDirectory: boolean;
  stat: Stats;
}

const KNOWN_TYPES = new Set(['pdf', 'docx', 'txt', 'json']);

const CONTENT_TYPES: Record<string, { contentType: string; inline: boolean }> = {
  '.pdf': { contentType: 'application/pdf', inline: true },
  '.docx': {
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    inline: false,
  },
  '.txt': { contentType: 'text/plain; charset=utf-8', inline: true },
  '.json': { contentType: 'application/json', inline: true },
};
const DEFAULT_CONTENT_TYPE = {
  contentType: 'application/octet-stream',
  inline: false,
};

/** Browse bot-generated Applications/{date}/{company}/ tree (read-only). */
@Injectable()
export class GeneratedService {
  private readonly root: string;

  constructor(private readonly config: ConfigService) {
    this.root = this.config.get<string>('files.path')!;
  }

  listDates(): FolderInfo[] {
    return this.listDir(this.root)
      .filter((e) => e.isDirectory)
      .map((e) => this.toFolderInfo(e));
  }

  listCompanies(date: string): FolderInfo[] {
    const dir = safeJoin(this.root, date);
    return this.listDir(dir)
      .filter((e) => e.isDirectory)
      .map((e) => this.toFolderInfo(e));
  }

  listFiles(date: string, company: string): FileInfo[] {
    const dir = safeJoin(this.root, date, company);
    return this.listDir(dir).map((e) => ({
      name: e.name,
      size: e.isDirectory ? 0 : e.stat.size,
      type: e.isDirectory ? 'folder' : this.fileType(e.name),
      modified: e.stat.mtime.toISOString(),
    }));
  }

  resolveFile(
    date: string,
    company: string,
    file: string,
  ): { path: string; contentType: string; inline: boolean } {
    const path = safeJoin(this.root, date, company, file);
    let stat: Stats;
    try {
      stat = statSync(path);
    } catch {
      throw new NotFoundException('File not found');
    }
    if (!stat.isFile()) {
      throw new NotFoundException('File not found');
    }
    const { contentType, inline } =
      CONTENT_TYPES[extname(file).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
    return { path, contentType, inline };
  }

  private listDir(dirPath: string): DirEntry[] {
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

  private toFolderInfo(entry: DirEntry): FolderInfo {
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
    return KNOWN_TYPES.has(ext) ? ext : 'other';
  }
}
