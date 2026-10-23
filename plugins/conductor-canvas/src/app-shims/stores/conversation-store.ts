export function useConversationStore<T>(selector: (state: { activeThreadId: string | null; threads: Array<{ id: string; title?: string | null }>; setActiveThread: (id: string | null) => void }) => T): T {
  return selector({ activeThreadId: null, threads: [], setActiveThread: () => {} });
}
