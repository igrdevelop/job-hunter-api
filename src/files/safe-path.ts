import { BadRequestException } from '@nestjs/common';
import { isAbsolute, resolve, sep } from 'path';

/**
 * Resolves `segments` under `root`, rejecting anything that could escape it
 * (.., absolute paths, null bytes) — segments come straight from route params.
 */
export function safeJoin(root: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (
      !segment ||
      segment.includes('\0') ||
      segment.includes('..') ||
      isAbsolute(segment)
    ) {
      throw new BadRequestException('Invalid path segment');
    }
  }

  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, ...segments);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new BadRequestException('Invalid path');
  }
  return resolved;
}
