/**
 * The customer portal's chat opens the customer's own dealership's AI Agent,
 * only when that dealership is active and has its web chat on.
 */
import { dealershipChatView, isDealershipChatOn } from '../../src/services/customerDealershipChat.service';

const ORG = { slug: 'action-auto', name: 'Action Auto Utah', status: 'active', metadata: { aiAgentName: 'Anna' } };

afterEach(() => {
  delete process.env.WEBCHAT_ENABLED;
});

it("gives the dealership's chat key, name and agent name", () => {
  expect(dealershipChatView(ORG)).toEqual({ available: true, orgKey: 'action-auto', dealerName: 'Action Auto Utah', agentName: 'Anna' });
});

it('leaves out an agent name the dealership never set', () => {
  expect(dealershipChatView({ ...ORG, metadata: {} })).toEqual({ available: true, orgKey: 'action-auto', dealerName: 'Action Auto Utah' });
});

it('shows no chat for a missing, inactive or chat-off dealership', () => {
  expect(dealershipChatView(null)).toEqual({ available: false });
  expect(dealershipChatView({ ...ORG, status: 'suspended' })).toEqual({ available: false });
  expect(dealershipChatView({ ...ORG, slug: '' })).toEqual({ available: false });
  expect(dealershipChatView({ ...ORG, metadata: { webchatEnabled: false } })).toEqual({ available: false });
});

it('follows the web chat switch for every dealership', () => {
  expect(isDealershipChatOn({})).toBe(true);
  process.env.WEBCHAT_ENABLED = 'false';
  expect(isDealershipChatOn({})).toBe(false);
});
