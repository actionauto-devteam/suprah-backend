import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const mockOptOutUpsert = jest.fn().mockResolvedValue({});

jest.mock('../../src/models/EmailOptOut.model', () => ({ __esModule: true, default: { findOneAndUpdate: mockOptOutUpsert } }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import config from '../../src/config';
import emailUnsubscribeRoutes from '../../src/routes/emailUnsubscribe.routes';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use('/api/email/unsubscribe', emailUnsubscribeRoutes);

function token(purpose = 'automated_email_unsubscribe') {
  return jwt.sign({ organizationId: 'org-1', email: 'jordan@example.com', purpose }, config.jwt.emailOptOutSecret, { expiresIn: '1y' });
}

describe('unsubscribe endpoint supports RFC 8058 one-click', () => {
  beforeEach(() => jest.clearAllMocks());

  it('a one-click POST to the List-Unsubscribe URL opts the address out without any login or confirmation page', async () => {
    const res = await request(app)
      .post(`/api/email/unsubscribe?token=${encodeURIComponent(token())}`)
      .type('form')
      .send('List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);
    expect(mockOptOutUpsert).toHaveBeenCalledWith(
      { organizationId: 'org-1', email: 'jordan@example.com' },
      expect.objectContaining({ $set: expect.objectContaining({ optedOut: true }) }),
      { upsert: true },
    );
  });

  it('opening the link (GET) only shows a confirmation page and never opts out, so link scanners cannot unsubscribe people', async () => {
    const res = await request(app).get(`/api/email/unsubscribe?token=${encodeURIComponent(token())}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Confirm unsubscribe');
    expect(mockOptOutUpsert).not.toHaveBeenCalled();
  });

  it('rejects a bad or wrong-purpose token', async () => {
    const bad = await request(app).post('/api/email/unsubscribe?token=not-a-token').type('form').send('List-Unsubscribe=One-Click');
    const wrongPurpose = await request(app).post(`/api/email/unsubscribe?token=${encodeURIComponent(token('something_else'))}`);
    expect(bad.status).toBe(400);
    expect(wrongPurpose.status).toBe(400);
    expect(mockOptOutUpsert).not.toHaveBeenCalled();
  });
});
