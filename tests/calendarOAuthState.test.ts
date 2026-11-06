import crypto from 'crypto';
import mongoose from 'mongoose';
import { readCalendarState, signCalendarState } from '../src/utils/calendarOAuthState';

describe('Google Calendar sign-in state', () => {
  const crmUserId = String(new mongoose.Types.ObjectId());

  it('gives back the same person only for a state Suprah signed', () => {
    const state = signCalendarState(crmUserId);
    expect(readCalendarState(state)).toBe(crmUserId);
    expect(signCalendarState(crmUserId)).not.toBe(state);
  });

  it('refuses a plain user id, which is what the old link sent and what anyone could type', () => {
    expect(readCalendarState(crmUserId)).toBeNull();
    expect(readCalendarState(undefined)).toBeNull();
    expect(readCalendarState(['a', 'b'])).toBeNull();
    expect(readCalendarState('')).toBeNull();
  });

  it('refuses a state that was changed to point at someone else', () => {
    const state = signCalendarState(crmUserId);
    const [, signature] = state.split('.');
    const otherId = String(new mongoose.Types.ObjectId());
    const forged = Buffer.from(JSON.stringify({ u: otherId, e: Date.now() + 60000, n: 'x' })).toString('base64url');
    expect(readCalendarState(`${forged}.${signature}`)).toBeNull();
    expect(readCalendarState(`${state}x`)).toBeNull();
    expect(readCalendarState(`${state}.extra`)).toBeNull();
  });

  it('refuses a state signed for another sign-in, like Gmail', () => {
    const secret = process.env.CRM_JWT_SECRET || process.env.JWT_SECRET || 'crm-secret-key';
    const payload = Buffer.from(JSON.stringify({ u: crmUserId, e: Date.now() + 60000, n: 'x' })).toString('base64url');
    const plain = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    expect(readCalendarState(`${payload}.${plain}`)).toBeNull();
  });

  it('expires after 15 minutes', () => {
    const start = Date.now();
    const state = signCalendarState(crmUserId, start);
    expect(readCalendarState(state, start + 14 * 60 * 1000)).toBe(crmUserId);
    expect(readCalendarState(state, start + 16 * 60 * 1000)).toBeNull();
  });

  it('refuses a signed state whose id is not a real id', () => {
    const state = signCalendarState('not-an-id');
    expect(readCalendarState(state)).toBeNull();
  });
});
