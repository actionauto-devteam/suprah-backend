import mongoose from 'mongoose';
import { readCalendarStateDetails, readCalendarState, signCalendarState } from '../../src/utils/calendarOAuthState';

it('keeps the upstream signed state format and adds a signed Meet return path', () => {
  const id = String(new mongoose.Types.ObjectId());
  const state = signCalendarState(id, Date.now(), '/crm/suprah-meet');
  expect(readCalendarState(state)).toBe(id);
  expect(readCalendarStateDetails(state)).toEqual({ crmUserId: id, returnTo: '/crm/suprah-meet', requiresCookie: true });
});

it('preserves in-flight upstream sign-ins issued before the return-path cookie existed', () => {
  const id = String(new mongoose.Types.ObjectId());
  expect(readCalendarStateDetails(signCalendarState(id))).toEqual({ crmUserId: id,
    returnTo: '/crm/appointments', requiresCookie: false });
});

it('rejects tampered and expired signed return paths', () => {
  const now = Date.now();
  const state = signCalendarState(String(new mongoose.Types.ObjectId()), now, '/crm/suprah-meet');
  expect(readCalendarStateDetails(state + 'changed')).toBeNull();
  expect(readCalendarStateDetails(state, now + 16 * 60_000)).toBeNull();
});

it('malformed Unicode signatures are rejected without throwing from the callback', () => {
  const state = signCalendarState(String(new mongoose.Types.ObjectId()));
  const [payload] = state.split('.');
  expect(() => readCalendarStateDetails(`${payload}.${'é'.repeat(43)}`)).not.toThrow();
  expect(readCalendarStateDetails(`${payload}.${'é'.repeat(43)}`)).toBeNull();
});
