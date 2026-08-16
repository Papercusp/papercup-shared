import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { harnessPath, orgPath } from './_admin-paths';

const ORG_PREFIX = '/api/org/';
const HARNESS_PREFIX = '/api/harness/';

describe('admin-paths (property-based)', () => {
  it('orgPath always begins with /api/org/ and is invertible', () => {
    fc.assert(
      fc.property(fc.string(), (rel) => {
        const out = orgPath(rel);
        expect(out.startsWith(ORG_PREFIX)).toBe(true);
        expect(out.slice(ORG_PREFIX.length)).toBe(rel);
      }),
    );
  });

  it('harnessPath always begins with /api/harness/ and is invertible', () => {
    fc.assert(
      fc.property(fc.string(), (rel) => {
        const out = harnessPath(rel);
        expect(out.startsWith(HARNESS_PREFIX)).toBe(true);
        expect(out.slice(HARNESS_PREFIX.length)).toBe(rel);
      }),
    );
  });

  it('the two builders never collide: orgPath(x) ≠ harnessPath(y) for any x, y', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(orgPath(a)).not.toBe(harnessPath(b));
      }),
    );
  });
});
