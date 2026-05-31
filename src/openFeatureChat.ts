/**
 * openFeatureChat — programmatic open of an agent chat in the dock.
 *
 * Extracted from the (now-retired) shared PiTerminalsDock copy so external
 * callers (FeatureList) don't pull the entire xterm + dockview module
 * graph just for a small fetch + event dispatch helper. The canonical
 * dock implementation lives in apps/operator/app/harness/PiTerminalsDock —
 * the operator listens for the same `papercusp:open-chat` event this
 * dispatches.
 */

export interface OpenChatEventDetail {
  slug: string;
  chatId: string;
  title?: string;
  role?: string;
  featureId?: string;
  /** Conversation mode carried to the chat panel: 'discuss' reframes a
   *  worker to talk the feature through first (vs the default 'chat'). */
  mode?: 'chat' | 'discuss';
}
export const OPEN_CHAT_EVENT = 'papercusp:open-chat';

/**
 * Pending opens are pushed to a window-level queue so the dock can drain
 * them on its next mount, even if it isn't mounted yet when this fn is
 * called. The dock pops from `window.__PAPERCUSP_PENDING_CHAT_OPENS__`
 * during its own onReady. Same shape the operator's PiTerminalsDock used
 * before the dock module moved out of this lib.
 */
type WindowWithQueue = Window & {
  __PAPERCUSP_PENDING_CHAT_OPENS__?: OpenChatEventDetail[];
};

export async function openFeatureChat(opts: {
  slug: string;
  role: string;
  featureId: string;
  title?: string;
  /** 'discuss' opens the chat in discuss mode (worker talks it through
   *  first, doesn't implement). Carried to the panel + sent per message;
   *  the agent-chats stream handler reads it when assembling the prompt. */
  mode?: 'chat' | 'discuss';
}): Promise<{ chatId: string } | { error: string }> {
  try {
    const r = await fetch(`/api/harness/${encodeURIComponent(opts.slug)}/agent-chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: opts.role,
        feature_id: opts.featureId,
        title: opts.title,
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({} as { error?: string }));
      return { error: body.error ?? `HTTP ${r.status}` };
    }
    const chat = await r.json();
    const detail: OpenChatEventDetail = {
      slug: opts.slug,
      chatId: chat.id,
      title: chat.title,
      role: chat.role,
      featureId: chat.feature_id ?? undefined,
      ...(opts.mode ? { mode: opts.mode } : {}),
    };
    if (typeof window !== 'undefined') {
      const w = window as WindowWithQueue;
      const queue = w.__PAPERCUSP_PENDING_CHAT_OPENS__ ?? [];
      queue.push(detail);
      w.__PAPERCUSP_PENDING_CHAT_OPENS__ = queue;
      window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail }));
    }
    return { chatId: chat.id };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
