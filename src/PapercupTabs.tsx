'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface PapercupTabsProps {
  /**
   * Path prefix to mount the papercup tabs under.
   *   - admin uses '/papercup'
   *   - public site uses '' (so / is the overview)
   */
  basePath: '' | '/papercup';
}

const TABS_DEF = [
  { slug: '/documentation', label: 'Documentation', short: 'Docs',     eyebrow: 'Harness reference',  icon: '📖' },
  { slug: '/harnesses',     label: 'Harnesses',     short: 'Ops',      eyebrow: 'Live ops cockpit',   icon: '↯' },
  { slug: '/organization',  label: 'Organization',  short: 'Org',      eyebrow: 'Directors',          icon: '◇' },
  { slug: '/projects',      label: 'Projects',      short: 'Projects', eyebrow: 'Portfolio',          icon: '▦' },
  { slug: '/timeline',      label: 'Timeline',      short: 'Activity', eyebrow: 'Activity',           icon: '⌁' },
] as const;

export default function PapercupTabs({ basePath }: PapercupTabsProps) {
  const pathname = usePathname();
  // If the user is currently inside /harnesses/<slug>, capture the slug so the
  // Documentation tab can deep-link to docs for that specific harness instead
  // of the generic landing page.
  const harnessesPrefix = `${basePath}/harnesses/`;
  const currentHarnessSlug =
    pathname.startsWith(harnessesPrefix)
      ? pathname.slice(harnessesPrefix.length).split('/')[0] || null
      : null;
  const TABS = TABS_DEF.map((t) => ({
    ...t,
    href:
      t.slug === '/documentation' && currentHarnessSlug
        ? `${basePath}${t.slug}?harness=${encodeURIComponent(currentHarnessSlug)}`
        : `${basePath}${t.slug}`,
  }));
  const isTabActive = (tab: (typeof TABS)[number]) => {
    const tabPath = `${basePath}${tab.slug}`;
    return pathname === tabPath || pathname.startsWith(`${tabPath}/`);
  };
  const activeTab = TABS.find(isTabActive) ?? null;
  const activeIndex = activeTab ? TABS.findIndex((tab) => tab.slug === activeTab.slug) + 1 : 0;
  return (
    <nav className="pc-tabs-wrap" aria-label="Papercup sections">
      <div className="pc-tabs" role="tablist" aria-label="Papercup workspace tabs">
        {TABS.map((tab) => {
          const active = isTabActive(tab);
          return (
            <Link
              key={tab.slug}
              href={tab.href}
              role="tab"
              aria-selected={active}
              aria-current={active ? 'page' : undefined}
              aria-label={tab.label}
              className={`pc-tab${active ? ' is-active' : ''}`}
            >
              <span className="pc-tab-icon" aria-hidden="true">{tab.icon}</span>
              <span className="pc-tab-copy">
                <strong>
                  <span className="pc-tab-full">{tab.label}</span>
                  <span className="pc-tab-short">{tab.short}</span>
                </strong>
                <em>{tab.eyebrow}</em>
              </span>
            </Link>
          );
        })}
      </div>
      <div className="pc-tab-context" aria-live="polite">
        {activeTab ? (
          <>
            <span>Viewing {activeTab.label}</span>
            <b>{activeTab.eyebrow}</b>
          </>
        ) : (
          <>
            <span>Home</span>
            <b>Live, public, read-only</b>
          </>
        )}
        {basePath === '' && (
          <span className="pc-tab-context-links">
            <a href="mailto:definitelyahuman@papercupai.com">Contact definitelyahuman@papercupai.com</a> with any questions.{' '}
            <a href="https://www.youtube.com/channel/UCyyqheEakkO-YaixP4kQdVQ/" target="_blank" rel="noopener">Subscribe to the youtube channel</a> for updates.{' '}
            <a href="https://discord.gg/TqRCqsGg" target="_blank" rel="noopener">Join the discord</a> for definitely human interaction.
          </span>
        )}
        <em>{activeTab ? `${activeIndex}/${TABS.length} · compact command display` : 'compact command display'}</em>
      </div>
    </nav>
  );
}
