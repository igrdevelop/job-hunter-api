import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { extname, join } from 'path';
import { FilesService } from '../files/files.service';

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
export class TemplatesService implements OnModuleInit {
  private dir = '';
  private manifestPath = '';

  constructor(private readonly files: FilesService) {}

  onModuleInit(): void {
    this.dir = this.files.resolveWritablePath('templates');
    this.manifestPath = join(this.dir, 'manifest.json');
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.manifestPath)) {
      this.writeManifest({ templates: [] });
    }
  }

  list(category?: TemplateCategory): Template[] {
    const all = this.readManifest().templates;
    if (!category) return all;
    return all.filter((t) => t.category === category);
  }

  get(id: string): Template {
    const template = this.readManifest().templates.find((t) => t.id === id);
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  resolveContent(id: string): string {
    const template = this.get(id);
    const path = join(this.dir, template.fileName);
    if (!existsSync(path)) throw new NotFoundException('Template file missing');
    return path;
  }

  create(
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
    const dest = join(this.dir, fileName);
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

    const manifest = this.readManifest();
    manifest.templates.unshift(template);
    this.writeManifest(manifest);
    return template;
  }

  remove(id: string): void {
    const manifest = this.readManifest();
    const idx = manifest.templates.findIndex((t) => t.id === id);
    if (idx < 0) throw new NotFoundException('Template not found');
    const [removed] = manifest.templates.splice(idx, 1);
    this.writeManifest(manifest);
    const path = join(this.dir, removed.fileName);
    if (existsSync(path)) unlinkSync(path);
  }

  private readManifest(): Manifest {
    try {
      return JSON.parse(readFileSync(this.manifestPath, 'utf8')) as Manifest;
    } catch {
      return { templates: [] };
    }
  }

  private writeManifest(manifest: Manifest): void {
    writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2));
  }
}

function fileTypeFromExt(ext: string): string {
  const e = ext.replace('.', '').toLowerCase();
  if (e === 'md' || e === 'yaml' || e === 'yml') return 'txt';
  if (['pdf', 'docx', 'txt', 'json'].includes(e)) return e;
  return 'other';
}
