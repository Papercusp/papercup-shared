/**
 * @vitest-environment jsdom
 *
 * Tooltip.test.tsx — the small Radix-tooltip wrapper. Its only branch is the
 * empty-label guard (`if (!label) return <>{children}</>`): with no label the
 * component must render its children verbatim with NO tooltip trigger wrapper,
 * and with a label it must render the trigger around the children. The content
 * itself lives in a Portal that only mounts on open, so we assert the
 * always-present trigger surface, not the hover content.
 *
 * jsdom env + @testing-library/react. Console stays silent (the default
 * vitest-fail-on-console setup is on).
 */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as RT from '@radix-ui/react-tooltip';
import { Tooltip } from './Tooltip';

afterEach(() => cleanup());

// Radix's Tooltip.Root must sit under a TooltipProvider (the app mounts a
// single one at its root). Wrap label-bearing renders to mirror that.
function withProvider(node: ReactNode) {
  return <RT.Provider>{node}</RT.Provider>;
}

describe('Tooltip — empty-label guard', () => {
  it('renders children verbatim and adds no trigger wrapper when label is empty', () => {
    const { container } = render(
      <Tooltip label={null}>
        <button data-testid="child">Click</button>
      </Tooltip>,
    );
    const child = screen.getByTestId('child');
    expect(child).toBeDefined();
    // No Radix trigger attribute when the guard short-circuits.
    expect(container.querySelector('[data-state]')).toBeNull();
    // The child is the lone top-level node.
    expect(container.firstElementChild).toBe(child);
  });

  it('treats an empty-string label as "no label" (falsy guard)', () => {
    const { container } = render(
      <Tooltip label="">
        <span data-testid="child">x</span>
      </Tooltip>,
    );
    expect(container.querySelector('[data-state]')).toBeNull();
    expect(screen.getByTestId('child')).toBeDefined();
  });
});

describe('Tooltip — with a label', () => {
  it('renders the children as the tooltip trigger', () => {
    render(
      withProvider(
        <Tooltip label="Helpful hint">
          <button data-testid="child">Hover me</button>
        </Tooltip>,
      ),
    );
    const child = screen.getByTestId('child');
    // Radix marks the trigger element with data-state (closed until hovered).
    expect(child.getAttribute('data-state')).toBe('closed');
  });

  it('passes the children through (asChild) rather than wrapping in an extra element', () => {
    render(
      withProvider(
        <Tooltip label="hint" side="right" align="start">
          <button data-testid="child">Go</button>
        </Tooltip>,
      ),
    );
    const child = screen.getByTestId('child');
    // asChild → the trigger IS the button, not a wrapper around it.
    expect(child.tagName).toBe('BUTTON');
    expect(child.textContent).toBe('Go');
  });
});
