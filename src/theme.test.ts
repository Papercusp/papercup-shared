/**
 * theme.test.ts — config-aware status/board derivation helpers + the STATUS
 * Proxy fallback. These are pure functions that drive the harness dashboard's
 * FeatureList / board columns / saved views; the Proxy fallback specifically
 * exists to stop `STATUS[unknownStatus].label` from crashing the whole
 * FeatureList subtree at hydration when a parent harness's non-coding statuses
 * are loaded (see the doc-comment on the Proxy in theme.ts).
 *
 * Pure unit — no DOM, no fetch. Grounds every expectation in the real tables
 * declared in theme.ts (coding-harness STATUS + the org-level
 * DEFAULT_STATUS_COLORS).
 */
import { describe, expect, it } from 'vitest';
import {
  STATUS,
  STATUS_ORDER,
  BOARD_COLUMN_ORDER,
  getStatusMeta,
  getBoardColumnOrder,
  getStatusOrder,
  getSuccessState,
  getSavedViews,
  type HarnessConfig,
} from './theme';

describe('STATUS proxy', () => {
  it('returns the real metadata for a known coding-harness status', () => {
    expect(STATUS.todo.label).toBe('Todo');
    expect(STATUS.in_progress.label).toBe('In progress');
    expect(STATUS.passed.solid).toBe('#10b981');
  });

  it('returns the neutral fallback for any unknown status instead of crashing', () => {
    // Parent-harness statuses (proposed/approved/…) are NOT in the coding table.
    // Without the Proxy this would be `undefined.label` → subtree crash.
    const unknown = (STATUS as Record<string, { label: string; solid: string }>)['proposed'];
    expect(unknown).toBeDefined();
    expect(unknown.label).toBe('Unknown');
    expect(unknown.solid).toBe('#6b7280');
  });

  it('a totally arbitrary key still resolves to the fallback object', () => {
    const meta = (STATUS as Record<string, { label: string }>)['☃-not-a-status'];
    expect(meta.label).toBe('Unknown');
  });
});

describe('getStatusMeta', () => {
  it('coding-harness status resolves via the legacy STATUS const', () => {
    expect(getStatusMeta('failing')).toEqual(STATUS.failing);
    expect(getStatusMeta('failing').label).toBe('Failing');
  });

  it('org-level status resolves via this module DEFAULT_STATUS_COLORS', () => {
    const proposed = getStatusMeta('proposed');
    expect(proposed.label).toBe('Proposed');
    expect(proposed.solid).toBe('#6b7280');
    const launched = getStatusMeta('launched');
    expect(launched.label).toBe('Launched');
    expect(launched.solid).toBe('#10b981');
  });

  it('an entirely unknown status humanizes its key into a label', () => {
    const meta = getStatusMeta('needs_review');
    expect(meta.label).toBe('Needs Review');
    // falls back to the neutral fallback colors
    expect(meta.solid).toBe('#6b7280');
  });

  it('a config statusColors override wins, merged over the default meta', () => {
    const config: HarnessConfig = {
      statusColors: { proposed: { solid: '#ff0000' } },
    };
    const meta = getStatusMeta('proposed', config);
    expect(meta.solid).toBe('#ff0000'); // override applied
    // label falls back to the default meta's label when the override omits it
    expect(meta.label).toBe('Proposed');
    // unspecified fields fall back to default meta
    expect(meta.bg).toBe('rgba(107,114,128,0.15)');
  });

  it('a config override on an unknown status uses the override label, else humanizes', () => {
    const withLabel = getStatusMeta('weird_state', {
      statusColors: { weird_state: { solid: '#123456', label: 'Weird!' } },
    });
    expect(withLabel.solid).toBe('#123456');
    expect(withLabel.label).toBe('Weird!');

    const noLabel = getStatusMeta('weird_state', {
      statusColors: { weird_state: { solid: '#123456' } },
    });
    expect(noLabel.label).toBe('Weird State'); // humanized fallback
  });

  it('a coding-harness status ignores config overrides (legacy STATUS takes precedence)', () => {
    const meta = getStatusMeta('todo', {
      statusColors: { todo: { solid: '#ffffff', label: 'Overridden' } },
    });
    // `status in STATUS` short-circuits before config is consulted.
    expect(meta).toEqual(STATUS.todo);
    expect(meta.label).toBe('Todo');
  });
});

describe('getBoardColumnOrder', () => {
  it('falls back to the coding-harness BOARD_COLUMN_ORDER with no config', () => {
    expect(getBoardColumnOrder()).toEqual(BOARD_COLUMN_ORDER);
  });

  it('prefers an explicit boardColumnOrder', () => {
    const order = ['a', 'b', 'c'];
    expect(getBoardColumnOrder({ boardColumnOrder: order })).toBe(order);
  });

  it('falls back to itemStates when boardColumnOrder is absent', () => {
    const items = ['x', 'y'];
    expect(getBoardColumnOrder({ itemStates: items })).toBe(items);
  });

  it('ignores an empty boardColumnOrder and uses itemStates', () => {
    const items = ['only'];
    expect(getBoardColumnOrder({ boardColumnOrder: [], itemStates: items })).toBe(items);
  });
});

describe('getStatusOrder', () => {
  it('falls back to the coding-harness STATUS_ORDER with no config', () => {
    expect(getStatusOrder()).toEqual(STATUS_ORDER);
  });

  it('prefers an explicit statusOrder', () => {
    const order = ['one', 'two'];
    expect(getStatusOrder({ statusOrder: order })).toBe(order);
  });

  it('derives non-terminal-first ordering from itemStates + terminalStates', () => {
    const out = getStatusOrder({
      itemStates: ['open', 'doing', 'done', 'archived'],
      terminalStates: ['done', 'archived'],
    });
    expect(out).toEqual(['open', 'doing', 'done', 'archived']);
  });

  it('with itemStates but no terminalStates, every state is treated non-terminal (order preserved)', () => {
    const out = getStatusOrder({ itemStates: ['b', 'a', 'c'] });
    expect(out).toEqual(['b', 'a', 'c']);
  });

  it('places terminal states last even when listed first in itemStates', () => {
    const out = getStatusOrder({
      itemStates: ['done', 'open', 'doing'],
      terminalStates: ['done'],
    });
    expect(out).toEqual(['open', 'doing', 'done']);
  });
});

describe('getSuccessState', () => {
  it('defaults to "passed" (coding-harness success state)', () => {
    expect(getSuccessState()).toBe('passed');
    expect(getSuccessState({})).toBe('passed');
  });

  it('honors a configured successState', () => {
    expect(getSuccessState({ successState: 'launched' })).toBe('launched');
  });
});

describe('getSavedViews', () => {
  it('returns the coding-harness default saved views with no config', () => {
    const views = getSavedViews();
    expect(views.map((v) => v.id)).toEqual(['running', 'blocked', 'todo', 'done']);
    const running = views.find((v) => v.id === 'running');
    expect(running?.filter.statuses).toEqual(['in_progress', 'validating']);
  });

  it('returns configured saved views when provided', () => {
    const custom = [{ id: 'mine', name: 'Mine', filter: { statuses: ['open'] } }];
    expect(getSavedViews({ savedViews: custom })).toBe(custom);
  });

  it('ignores an empty configured savedViews array and uses the defaults', () => {
    const views = getSavedViews({ savedViews: [] });
    expect(views.map((v) => v.id)).toEqual(['running', 'blocked', 'todo', 'done']);
  });
});
