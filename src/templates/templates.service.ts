import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { extname, join } from 'path';
import { UserPathsService } from '../users/user-paths.service';

export type TemplateCategory = 'resume' | 'cover-letter' | 'portfolio' | 'other';

export interface Template {
  id: string;
  name: string;
  category: TemplateCategory;
  fileType: string;
  size: number;
  modified: string;
  description?: string;
  fileName: string;
}

interface Manifest {
  templates: Template[];
}

const CATEGORIES = new Set<TemplateCategory>([
  'resume',
  'cover-letter',
  'portfolio',
  'other',
]);

@Injectable()
export class TemplatesService {
  constructor(private readonly userPaths: UserPathsService) {}

  private dir(userId: string): string {
    const d = this.userPaths.templatesDir(userId);
    mkdirSync(d, { recursive: true });
    return d;
  }

  private manifestPath(userId: string): string {
    return join(this.dir(userId), 'manifest.json');
  }

  list(userId: string, category?: TemplateCategory): Template[] {
    const all = this.readManifest(userId).templates;
    if (!category) return all;
    return all.filter((t) => t.category === category);
  }

  get(userId: string, id: string): Template {
    const template = this.readManifest(userId).templates.find((t) => t.id === id);
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  resolveContent(userId: string, id: string): string {
    const template = this.get(userId, id);
    const path = join(this.dir(userId), template.fileName);
    if (!existsSync(path)) throw new NotFoundException('Template file missing');
    return path;
  }

  create(
    userId: string,
    file: Express.Multer.File,
    meta: { name: string; category: TemplateCategory; description?: string },
  ): Template {
    if (!file?.buffer?.length) throw new BadRequestException('Empty file');
    if (!meta.name?.trim()) throw new BadRequestException('Name required');
    if (!CATEGORIES.has(meta.category)) {
      throw new BadRequestException('Invalid category');
    }

    const id = crypto.randomUUID();
    const ext = extname(file.originalname).toLowerCase() || '.bin';
    const fileName = `${id}${ext}`;
    const dest = join(this.dir(userId), fileName);
    writeFileSync(dest, file.buffer);

    const template: Template = {
      id,
      name: meta.name.trim(),
      category: meta.category,
      fileType: fileTypeFromExt(ext),
      size: file.buffer.length,
      modified: new Date().toISOString(),
      description: meta.description?.trim() || undefined,
      fileName,
    };

    const manifest = this.readManifest(userId);
    manifest.templates.unshift(template);
    this.writeManifest(userId, manifest);
    return template;
  }

  remove(userId: string, id: string): void {
    const manifest = this.readManifest(userId);
    const idx = manifest.templates.findIndex((t) => t.id === id);
    if (idx < 0) throw new NotFoundException('Template not found');
    const [removed] = manifest.templates.splice(idx, 1);
    this.writeManifest(userId, manifest);
    const path = join(this.dir(userId), removed.fileName);
    if (existsSync(path)) unlinkSync(path);
  }

  private readManifest(userId: string): Manifest {
    const mp = this.manifestPath(userId);
    if (!existsSync(mp)) return { templates: [] };
    try {
      return JSON.parse(readFileSync(mp, 'utf8')) as Manifest;
    } catch {
      return { templates: [] };
    }
  }

  private writeManifest(userId: string, manifest: Manifest): void {
    writeFileSync(this.manifestPath(userId), JSON.stringify(manifest, null, 2));
  }
}

function fileTypeFromExt(ext: string): string {
  const e = ext.replace('.', '').toLowerCase();
  if (e === 'md' || e === 'yaml' || e === 'yml') return 'txt';
  if (['pdf', 'docx', 'txt', 'json'].includes(e)) return e;
  return 'other';
}
