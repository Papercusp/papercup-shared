// @papercusp/papercup-shared — single source of truth for the Papercup view tree.
// Both apps/web/app/papercup AND apps/public-site import from here, so any
// edit to a view propagates to both renders.
//
// Naming convention:
//   <X>View      = presentational component
//   PapercupTabs = the tab strip + context block
//   papercup.css = shared stylesheet (import via './papercup.css')

export { default as PapercupTabs } from './PapercupTabs';
export type { PapercupTabsProps } from './PapercupTabs';

export { useAgentRoles } from './useAgentRoles';



export { default as OrganizationView } from './OrganizationView';
export type { OrganizationViewProps, Department } from './OrganizationView';

export { default as DirectivesView } from './DirectivesView';
export type { DirectivesViewProps } from './DirectivesView';

export { default as ProjectsView } from './ProjectsView';
export type { ProjectsViewProps } from './ProjectsView';

export { default as TimelineView } from './TimelineView';
export type { TimelineViewProps } from './TimelineView';


export { default as HarnessesView } from './HarnessesView';
export type { HarnessesViewProps } from './HarnessesView';

export { default as HarnessesReadOnlyView } from './HarnessesReadOnlyView';
export type { HarnessesReadOnlyViewProps, HarnessesSnapshot, HarnessRow } from './HarnessesReadOnlyView';

export { default as HarnessDetailView } from './HarnessDetailView';
export type { HarnessDetailViewProps, HarnessDetailPayload, HarnessDetailTab, HarnessKind } from './HarnessDetailView';

export { default as BrainstormReadOnlyView } from './BrainstormReadOnlyView';
export type { BrainstormReadOnlyViewProps, BrainstormPayload } from './BrainstormReadOnlyView';

export { default as InboxReadOnlyView } from './InboxReadOnlyView';
export type { InboxReadOnlyViewProps, InboxPayload, InboxMessage } from './InboxReadOnlyView';

export { default as PublicChatView } from './PublicChatView';
export type { PublicChatViewProps } from './PublicChatView';

export { default as HarnessConsoleView } from './HarnessConsoleView';
export type {
  HarnessConsoleViewProps,
  HarnessConsolePayload,
  HarnessFeatureRow,
  HarnessAgentRun,
  HarnessReview,
  HarnessProposal,
  HarnessLane,
  HarnessHealthCheck,
} from './HarnessConsoleView';

export { default as BriefingsView } from './BriefingsView';
export type { BriefingsViewProps } from './BriefingsView';

export { default as DocumentationFrame } from './DocumentationFrame';

// PiTerminalsDock and PiPanel used to live here too. The canonical
// implementations now live in apps/operator/app/harness/* — the lib
// copies were ~half the size and missed the WS/Tauri/flow-control work.
// Only the small openFeatureChat helper is consumed externally
// (FeatureList → dock), and it's retained as its own file so callers
// don't have to pull the dock's entire xterm/dockview graph.
export { openFeatureChat, OPEN_CHAT_EVENT, type OpenChatEventDetail } from './openFeatureChat';

// Backend-aware agent CLI runner lives at `@papercusp/papercup-shared/agent`
// — server-only entry point so client chunks don't try to bundle
// node:child_process. Don't re-export from this main index.
