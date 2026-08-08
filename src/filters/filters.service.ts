import { BadRequestException, Injectable } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { JSON_SCHEMA, dump, load } from 'js-yaml';
import { join } from 'path';
import { UserPathsService } from '../users/user-paths.service';
import {
  BUILTIN_DEFAULTS,
  FilterProfile,
  buildFiltersMeta,
} from './filters-schema';
import {
  FilterOverrides,
  mergeFilters,
  stripDefaultsForWrite,
  validateOverrides,
} from './filters-validator';

export interface FiltersResponse {
  defaults: FilterProfile;
  overrides: FilterOverrides;
  effective: FilterProfile;
  meta: ReturnType<typeof buildFiltersMeta>;
}

@Injectable()
export class FiltersService {
  constructor(private readonly userPaths: UserPathsService) {}

  get(userId: string): FiltersResponse {
    return this.toResponse(this.readOverrides(userId));
  }

  put(userId: string, body: unknown): FiltersResponse {
    const result = validateOverrides(body);
    if (!result.ok) {
      throw new BadRequestException({ errors: result.errors });
    }

    const toWrite = stripDefaultsForWrite(result.value);
    this.writeOverrides(userId, toWrite);
    return this.toResponse(toWrite);
  }

  private toResponse(overrides: FilterOverrides): FiltersResponse {
    const defaults = structuredClone(BUILTIN_DEFAULTS);
    return {
      defaults,
      overrides,
      effective: mergeFilters(defaults, overrides),
      meta: buildFiltersMeta(),
    };
  }

  private filtersPath(userId: string): string {
    return join(this.userPaths.candidateDir(userId), 'filters.yaml');
  }

  private readOverrides(userId: string): FilterOverrides {
    const path = this.filtersPath(userId);
    if (!existsSync(path)) {
      return {};
    }
    try {
      const data = load(readFileSync(path, 'utf8'), { schema: JSON_SCHEMA });
      if (data === null || data === undefined) {
        return {};
      }
      if (typeof data !== 'object' || Array.isArray(data)) {
        return {};
      }
      // On-disk may arrive via raw files API; GET returns parsed content as-is.
      return data as FilterOverrides;
    } catch {
      return {};
    }
  }

  private writeOverrides(userId: string, overrides: FilterOverrides): void {
    const dir = this.userPaths.candidateDir(userId);
    mkdirSync(dir, { recursive: true });
    const dest = this.filtersPath(userId);
    const content = dump(overrides, {
      schema: JSON_SCHEMA,
      lineWidth: -1,
      noRefs: true,
      sortKeys: true,
    });

    // tmp + rename (atomic on POSIX). On Windows rename cannot replace, so
    // fall back to unlink+rename — brief missing-file window is acceptable
    // (single-user file, last-write-wins per FILTERS_API_PLAN).
    const tmp = `${dest}.tmp.${process.pid}`;
    writeFileSync(tmp, content, 'utf8');
    try {
      renameSync(tmp, dest);
    } catch {
      if (existsSync(dest)) {
        unlinkSync(dest);
      }
      renameSync(tmp, dest);
    }
  }
}
