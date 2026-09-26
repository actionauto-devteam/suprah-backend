jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), fatal: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.mock('../../src/utils/socketEmitter', () => ({ streamLogToAdmins: jest.fn() }));

import { errorHandler } from '../../src/middleware/error.middleware';
import { ApiError } from '../../src/utils/ApiError';

const run = (err: unknown) => {
  const send = jest.fn();
  const res: any = { status: jest.fn(() => ({ send })) };
  errorHandler(err as any, { url: '/x', method: 'GET', body: {}, params: {}, query: {} } as any, res, jest.fn());
  return { status: res.status.mock.calls[0][0], body: send.mock.calls[0][0] };
};

describe('error middleware user-facing messages', () => {
  it('never shows raw technical text for unexpected server errors', () => {
    const { status, body } = run(new TypeError("Cannot read properties of undefined (reading 'loadNumber')"));
    expect(status).toBe(500);
    expect(body.message).toMatch(/^Something went wrong on our side/);
    expect(body.message).not.toContain('loadNumber');
  });

  it('keeps deliberate ApiError messages, including 5xx ones', () => {
    expect(run(new ApiError(409, 'Load LD-1 changed. Refresh and try again.')).body.message).toBe('Load LD-1 changed. Refresh and try again.');
    expect(run(new ApiError(503, 'Document uploads are temporarily unavailable.')).body.message).toBe('Document uploads are temporarily unavailable.');
  });
});
