export function isMissingGmailThread(error: unknown): boolean {
  const failure = error as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null | undefined;
  return Number(failure?.code ?? failure?.status ?? failure?.response?.status) === 404;
}

export function isRevokedGoogleAccess(error: unknown): boolean {
  const failure = error as { message?: unknown; response?: { data?: { error?: unknown } } } | null | undefined;
  return failure?.response?.data?.error === 'invalid_grant' || failure?.message === 'invalid_grant';
}

type LeadThreads = { threadId?: unknown; previousThreadIds?: unknown[] | null } | null | undefined;

export function leadEmailThreadIds(lead: LeadThreads): string[] {
  return [...new Set([lead?.threadId, ...(lead?.previousThreadIds || [])].filter(Boolean).map(String))];
}

const sentAt = (entry: any) => new Date(entry?.timestamp ?? entry?.createdAt ?? 0).getTime();

export async function readLeadEmailThreads<T>(lead: LeadThreads, readThread: (threadId: any) => Promise<T[]>): Promise<T[]> {
  const threadIds = leadEmailThreadIds(lead);
  if (threadIds.length < 2) return readThread(threadIds.length ? threadIds[0] : lead?.threadId);
  const lists = await Promise.all(threadIds.map((threadId, index) => readThread(threadId).catch((error) => {
    if (index === 0) throw error;
    console.error(`[THREAD] Could not read an earlier email thread ${threadId}:`, error);
    return [] as T[];
  })));
  return lists.flat().sort((a, b) => sentAt(a) - sentAt(b));
}
