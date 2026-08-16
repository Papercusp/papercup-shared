import { describe, expect, it } from 'vitest';
import { harnessPath, orgPath } from './_admin-paths';

describe('admin-paths', () => {
  it('orgPath prefixes /api/org/', () => {
    expect(orgPath('users')).toBe('/api/org/users');
    expect(orgPath('roles/123')).toBe('/api/org/roles/123');
  });

  it('harnessPath prefixes /api/harness/', () => {
    expect(harnessPath('runs')).toBe('/api/harness/runs');
    expect(harnessPath('')).toBe('/api/harness/');
  });
});
