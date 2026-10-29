import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';

// Execute the real handlers with isolated database boundaries. No application
// startup, live credentials, or writes are needed for these read-path checks.
const source = fs.readFileSync(path.join(__dirname, '../../src/controllers/supraspace.controller.ts'), 'utf8');
const ast = ts.createSourceFile('controller.ts', source, ts.ScriptTarget.Latest, true);
function handler(name: string, dependencies: Record<string, unknown>) {
  const statement = ast.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === name));
  if (!statement) throw new Error(`Missing ${name}`);
  const compiled = ts.transpileModule(`${statement.getText(ast)}\nglobalThis.handler = ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const sandbox: any = {
    asyncHandler: (fn: unknown) => fn,
    ApiResponse: class { constructor(public statusCode: number, public data: unknown, public message: string) {} },
    ApiError: class extends Error { constructor(public statusCode: number, message: string) { super(message); } },
    escapeRegex: (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    getConversationLeftAt: () => null,
    mongoose: {
      isValidObjectId: (id: string) => /^[a-f0-9]{24}$/.test(id),
      Types: { ObjectId: class { constructor(public value: string) {} toString() { return this.value; } } },
    },
    ...dependencies,
  };
  vm.runInNewContext(compiled, sandbox);
  return sandbox.handler;
}

describe('SupraSpace search and navigation', () => {
  it('pages past 30 matches without skipping messages that share a timestamp', async () => {
    const timestamp = new Date('2026-10-29T00:00:00.000Z');
    const messages = Array.from({ length: 65 }, (_, index) => ({
      _id: (65 - index).toString(16).padStart(24, '0'), createdAt: timestamp, content: 'test',
    }));
    const find = jest.fn(filter => {
      const rows = filter.$or ? messages.filter(message => message._id < filter.$or[1]._id.$lt.toString()) : messages;
      let limit = 0;
      const query: any = {
        populate: () => query,
        sort: jest.fn(order => { expect(order).toEqual({ createdAt: -1, _id: -1 }); return query; }),
        limit: (count: number) => { limit = count; return query; },
        lean: async () => rows.slice(0, limit),
      };
      return query;
    });
    const search = handler('searchMessages', {
      SupraSpaceConversation: { findOne: () => ({ select: () => ({ lean: async () => ({ _id: 'conversation' }) }) }) },
      SupraSpaceMessage: { find },
    });
    const ids: string[] = [];
    let cursor = {};
    for (const expected of [30, 30, 5]) {
      let response: any;
      await search({ crmUser: { _id: 'user' }, query: { q: 'test', conversationId: 'conversation', ...cursor } }, { json: (value: unknown) => { response = value; } });
      expect(response.data).toHaveLength(expected);
      ids.push(...response.data.map((message: any) => message._id));
      cursor = response.nextCursor;
    }
    expect(new Set(ids).size).toBe(65);
    expect(cursor).toBeNull();
    expect(find.mock.calls[0][0].scheduledStatus).toEqual({ $ne: 'pending' });
  });

  it('does not search a conversation the user cannot access', async () => {
    const find = jest.fn();
    const search = handler('searchMessages', {
      SupraSpaceConversation: { findOne: () => ({ select: () => ({ lean: async () => null }) }) },
      SupraSpaceMessage: { find },
    });
    let response: any;
    await search({ crmUser: { _id: 'user' }, query: { q: 'test', conversationId: 'private' } }, { json: (value: unknown) => { response = value; } });
    expect(response.data).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });

  it('applies cleared and former-member history limits to exact-ID navigation', async () => {
    const clearedAt = new Date('2026-10-01');
    const leftAt = new Date('2026-10-15');
    const query: any = { populate: () => query, then: (resolve: (value: unknown) => void) => resolve({ _id: 'message' }) };
    const findOne = jest.fn(() => query);
    const navigate = handler('getDeliveredMessage', {
      SupraSpaceConversation: { findById: () => ({ lean: async () => ({ clearedAt: { user: clearedAt } }) }) },
      SupraSpaceMessage: { findOne },
      canReadConversationHistory: () => true,
      getConversationLeftAt: () => leftAt,
      serializeDeliveredMessage: async (message: unknown) => message,
    });
    await navigate({ crmUser: { _id: 'user' }, query: { history: 'true' }, params: { id: 'conversation', messageId: 'a'.repeat(24) } }, { json: jest.fn() });
    const filter = findOne.mock.calls[0][0] as any;
    expect(filter.createdAt.$gt.getTime()).toBe(clearedAt.getTime());
    expect(filter.createdAt.$lte).toBe(leftAt);
    expect(filter.scheduledStatus).toEqual({ $ne: 'pending' });
    await navigate({ crmUser: { _id: 'user' }, query: {}, params: { id: 'conversation', messageId: 'a'.repeat(24) } }, { json: jest.fn() });
    const reconciliationFilter = findOne.mock.calls[1][0] as any;
    expect(reconciliationFilter.scheduledStatus).toBeUndefined();
    expect(reconciliationFilter.createdAt).toBeUndefined();
  });

  it('excludes cleared history from search results and rejects invalid pagination', async () => {
    const clearedAt = new Date('2026-10-20');
    const query: any = { populate: () => query, sort: () => query, limit: () => query, lean: async () => [] };
    const find = jest.fn(() => query);
    const search = handler('searchMessages', {
      SupraSpaceConversation: { findOne: () => ({ select: () => ({ lean: async () => ({ _id: 'conversation', clearedAt: { user: clearedAt } }) }) }) },
      SupraSpaceMessage: { find },
    });
    const request = { crmUser: { _id: 'user' }, query: { q: 'test', conversationId: 'conversation' } };
    await search(request, { json: jest.fn() });
    const filter = find.mock.calls[0][0] as any;
    expect(filter.$and[0].$or[0].createdAt.$gt.getTime()).toBe(clearedAt.getTime());
    await expect(search({ ...request, query: { ...request.query, before: 'invalid', beforeId: 'bad' } }, { json: jest.fn() })).rejects.toThrow('Invalid search cursor');
  });
});
