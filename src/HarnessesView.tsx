import type { ReactNode } from 'react';

export interface HarnessesViewProps {
  basePath: '' | '/papercup';
  /** Slot for the admin-only HarnessDashboard embed. Public site passes nothing. */
  dashboardSlot?: ReactNode;
}

export default function HarnessesView({ dashboardSlot }: HarnessesViewProps) {
  if (!dashboardSlot) {
    return (
      <div style={{ padding: 24, color: '#7c89b1', fontSize: 13 }}>
        Live harness console is admin-only.
      </div>
    );
  }
  return <>{dashboardSlot}</>;
}
