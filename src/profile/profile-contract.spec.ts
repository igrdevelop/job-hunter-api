import { readFileSync } from 'fs';
import { join } from 'path';
import { validateProfile } from './profile-validate';

const fixturePath = join(
  __dirname,
  '..',
  '..',
  'test',
  'fixtures',
  'profile_contract_v1.json',
);

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<
  string,
  unknown
>;

describe('profile_contract_v1', () => {
  it('has schema_version 1', () => {
    expect(fixture.schema_version).toBe(1);
  });

  it('passes PUT validation unchanged', () => {
    const result = validateProfile(fixture);
    expect(result.ok).toBe(true);
  });

  it('fails with the right error when full_name is stripped', () => {
    const stripped = JSON.parse(JSON.stringify(fixture)) as {
      core: { identity: { full_name: string } };
    };
    stripped.core.identity.full_name = '';

    const result = validateProfile(stripped);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors['core.identity.full_name']).toBe(
        'core.identity.full_name is required',
      );
    }
  });
});
