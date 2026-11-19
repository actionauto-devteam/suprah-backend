import { isMissingGmailThread, isRevokedGoogleAccess, leadEmailThreadIds, readLeadEmailThreads } from '../../src/utils/gmailThread';

describe('Gmail thread helpers', () => {
  it('recognizes a missing thread and removed Google access', () => {
    expect(isMissingGmailThread({ code: 404 })).toBe(true);
    expect(isMissingGmailThread({ status: 404 })).toBe(true);
    expect(isMissingGmailThread({ response: { status: 404 } })).toBe(true);
    expect(isMissingGmailThread({ code: 500 })).toBe(false);
    expect(isMissingGmailThread(null)).toBe(false);
    expect(isRevokedGoogleAccess({ response: { data: { error: 'invalid_grant' } } })).toBe(true);
    expect(isRevokedGoogleAccess(new Error('invalid_grant'))).toBe(true);
    expect(isRevokedGoogleAccess({ code: 401 })).toBe(false);
  });

  it('lists the current thread first, then the earlier ones, without repeats', () => {
    expect(leadEmailThreadIds({ threadId: 'new', previousThreadIds: ['old-1', 'new', 'old-2'] })).toEqual(['new', 'old-1', 'old-2']);
    expect(leadEmailThreadIds({ threadId: null })).toEqual([]);
    expect(leadEmailThreadIds(null)).toEqual([]);
  });

  it('a lead with one thread or none is read exactly as before', async () => {
    const readThread = jest.fn(async (): Promise<any[]> => [{ id: 'a' }]);
    await readLeadEmailThreads({ threadId: 'th-1' }, readThread);
    await readLeadEmailThreads({ threadId: null }, readThread);
    expect(readThread.mock.calls).toEqual([['th-1'], [null]]);
  });

  it('adds the earlier threads in time order, and one that fails does not hide the others', async () => {
    const readThread = jest.fn(async (threadId: string): Promise<any[]> => {
      if (threadId === 'broken') throw new Error('Backend Error');
      if (threadId === 'new') return [{ id: 'n1', timestamp: new Date('2026-11-18T10:00:00Z') }];
      return [{ id: 'o1', timestamp: new Date('2026-11-01T10:00:00Z') }, { id: 'o2', timestamp: new Date('2026-11-02T10:00:00Z') }];
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const messages = await readLeadEmailThreads({ threadId: 'new', previousThreadIds: ['old', 'broken'] }, readThread);

    expect(messages.map((message) => message.id)).toEqual(['o1', 'o2', 'n1']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('a failure on the current thread is still reported', async () => {
    const readThread = jest.fn(async (threadId: string): Promise<any[]> => {
      if (threadId === 'new') throw new Error('Backend Error');
      return [];
    });
    await expect(readLeadEmailThreads({ threadId: 'new', previousThreadIds: ['old'] }, readThread)).rejects.toThrow('Backend Error');
  });
});
