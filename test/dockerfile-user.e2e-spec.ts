import { readFileSync } from 'fs';
import { join } from 'path';

// Pins the runtime user of the production image. The API and the bot write
// into the same host directories (users/, db/); the bot runs as uid 1000, so
// this image must too — a root API leaves root-owned dirs/files the bot cannot
// write into (profile render/preview jobs failed with EACCES from 2026-09-14).
// Static check over the Dockerfile text: cheap, no docker daemon needed.

const ROOT = join(__dirname, '..');

function finalStage(dockerfile: string): string[] {
  const lines = dockerfile
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  const lastFrom = lines.map((l) => /^FROM\s/i.test(l)).lastIndexOf(true);
  expect(lastFrom).toBeGreaterThanOrEqual(0);
  return lines.slice(lastFrom);
}

describe('production image runtime user', () => {
  const stage = finalStage(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'));

  it('switches to a non-root USER in the final stage', () => {
    const users = stage.filter((l) => /^USER\s/i.test(l));
    expect(users.length).toBeGreaterThan(0);
    const user = users[users.length - 1].split(/\s+/)[1];
    // The image's built-in `node` user is uid/gid 1000, the bot's `hunter` uid.
    expect(['node', '1000', '1000:1000', 'node:node']).toContain(user);
  });

  it('sets USER before CMD, so the server process is not root', () => {
    const userIdx = stage.map((l) => /^USER\s/i.test(l)).lastIndexOf(true);
    const cmdIdx = stage.findIndex((l) => /^CMD\s/i.test(l));
    expect(cmdIdx).toBeGreaterThan(userIdx);
  });

  it('is not overridden back to root by the prod compose file', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.prod.yml'), 'utf8');
    expect(compose).not.toMatch(/^\s*user:\s*["']?(root|0)(:|["']|\s|$)/m);
  });
});
