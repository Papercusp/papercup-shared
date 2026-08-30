/**
 * Regression coverage for EI-218505: chat-stream imports the governor registry
 * during module initialization. Re-evaluate both entry points concurrently so a
 * construction-before-default ordering bug fails here with an attributable TDZ.
 */
import { expect, test, vi } from 'vitest';

test('fresh chat-stream and governor-registry imports initialize AIMD defaults without a TDZ', async () => {
  vi.resetModules();

  const [chatStream, registry] = await Promise.all([
    import('./chat-stream'),
    import('./governor-registry'),
  ]);

  expect(registry.AIMD_CLEAN_TURNS_PER_STEP).toBe(5);
  expect(typeof registry.governorForBackend).toBe('function');
  expect(typeof chatStream.governorForStatelessTransport).toBe('function');
});
