const mockLocationFind = jest.fn();
const mockResolveVehicle = jest.fn();
jest.mock('../../src/models/CrmLocation.model', () => ({ __esModule: true, default: { find: (...args: unknown[]) => mockLocationFind(...args) } }));
jest.mock('../../src/services/leadLocation.service', () => ({ resolveVehicleContextForLead: (...args: unknown[]) => mockResolveVehicle(...args) }));

import { labelsForStore, resolveLeadStore, storeForLabel, storeForStock, type LeadStore } from '../../src/utils/leadStore';
import {
  campaignKindsFor,
  campaignSummary,
  firstContactForStaffLead,
  leadTypeCondition,
  leadTypeCountsFromGroup,
  parseLeadTypeFilter,
} from '../../src/utils/leadType';

const stores: LeadStore[] = [
  { name: 'Action Auto - Lehi', keys: ['action auto lehi', 'lehi'], stockPrefixes: ['L'] },
  { name: 'Action Auto - Orem', keys: ['action auto orem', 'aa orem'], stockPrefixes: ['M'] },
];

function locationRows(rows: unknown[]) {
  return { select: () => ({ sort: () => ({ lean: () => ({ catch: () => Promise.resolve(rows) }) }) }) };
}

describe('lead store grouping', () => {
  it('maps the feed label, the CRM name and lower case to the same store', () => {
    expect(storeForLabel(stores, 'LEHI')).toBe('Action Auto - Lehi');
    expect(storeForLabel(stores, 'Action Auto - Lehi')).toBe('Action Auto - Lehi');
    expect(storeForLabel(stores, ' lehi ')).toBe('Action Auto - Lehi');
  });

  it('matches a single word that only one store name contains', () => {
    expect(storeForLabel(stores, 'Orem')).toBe('Action Auto - Orem');
    expect(storeForLabel(stores, 'OREM')).toBe('Action Auto - Orem');
  });

  it('does not guess when the label fits both stores or none', () => {
    expect(storeForLabel(stores, 'Action Auto')).toBeNull();
    expect(storeForLabel(stores, 'Provo')).toBeNull();
    expect(storeForLabel(stores, '')).toBeNull();
    expect(storeForLabel([], 'Lehi')).toBeNull();
  });

  it('lists every saved label that belongs to a store', () => {
    expect(labelsForStore(stores, 'Action Auto - Lehi', ['LEHI', 'Action Auto - Lehi', 'Orem', '', null, 'Lehi'])).toEqual([
      'LEHI',
      'Action Auto - Lehi',
      'Lehi',
    ]);
  });
});

describe('lead type', () => {
  it('accepts only known filter values', () => {
    expect(parseLeadTypeFilter('outbound:team_text')).toBe('outbound:team_text');
    expect(parseLeadTypeFilter(' campaign ')).toBe('campaign');
    expect(parseLeadTypeFilter('outbound:anything')).toBeNull();
    expect(parseLeadTypeFilter(undefined)).toBeNull();
  });

  it('treats staff-added leads as outbound unless an inbound source was picked', () => {
    expect(firstContactForStaffLead(undefined)).toEqual({ firstContactBy: 'team', firstContactVia: 'added_by_team' });
    expect(firstContactForStaffLead('Manual Entry')).toEqual({ firstContactBy: 'team', firstContactVia: 'added_by_team' });
    expect(firstContactForStaffLead('Inbound Call')).toEqual({ firstContactBy: 'customer', firstContactVia: null });
    expect(firstContactForStaffLead('Third-Party Lead')).toEqual({ firstContactBy: 'customer', firstContactVia: null });
  });

  it('falls back to the source for leads saved before this change', () => {
    expect(leadTypeCondition('inbound')).toEqual({
      $or: [{ firstContactBy: 'customer' }, { firstContactBy: { $nin: ['customer', 'team'] }, source: { $ne: 'Manual Entry' } }],
    });
    expect(leadTypeCondition('outbound')).toEqual({
      $or: [{ firstContactBy: 'team' }, { firstContactBy: { $nin: ['customer', 'team'] }, source: 'Manual Entry' }],
    });
    expect(leadTypeCondition('outbound:team_call')).toEqual({ firstContactBy: 'team', firstContactVia: 'team_call' });
  });

  it('filters campaigns by the date they were sent', () => {
    expect(campaignKindsFor('campaign:price_drop')).toEqual(['price_drop']);
    expect(campaignKindsFor('campaign')).toHaveLength(4);
    expect(campaignKindsFor('inbound')).toBeNull();
    expect(leadTypeCondition('campaign:reengagement')).toEqual({ 'campaignSentAt.reengagement': { $type: 'date' } });
    expect((leadTypeCondition('campaign') as any).$or).toHaveLength(4);
  });

  it('marks a campaign as responded only when the customer wrote after it was sent', () => {
    const lead = {
      campaignSentAt: { priceDrop: '2026-11-10T15:00:00Z', reengagement: '2026-11-12T15:00:00Z' },
      followUp: { lastCustomerActivityAt: '2026-11-11T15:00:00Z' },
    };
    expect(campaignSummary(lead)).toEqual({ kind: 'reengagement', sentAt: new Date('2026-11-12T15:00:00Z'), responded: false });
    expect(campaignSummary(lead, ['price_drop'])).toEqual({ kind: 'price_drop', sentAt: new Date('2026-11-10T15:00:00Z'), responded: true });
    expect(campaignSummary({ campaignSentAt: { priceDrop: null } })).toBeNull();
  });

  it('turns the count row into filter keys', () => {
    expect(leadTypeCountsFromGroup({ inbound: 5, outbound: 2, team_text: 1, price_drop: 3, campaign: 3 })).toMatchObject({
      inbound: 5,
      outbound: 2,
      'outbound:team_text': 1,
      'outbound:team_call': 0,
      campaign: 3,
      'campaign:price_drop': 3,
    });
  });
});

describe('store from the stock number', () => {
  beforeEach(() => {
    mockLocationFind.mockReset();
    mockResolveVehicle.mockReset();
  });

  it('reads L as Lehi and M as Orem, in any letter case', () => {
    expect(storeForStock(stores, 'L24871')).toBe('Action Auto - Lehi');
    expect(storeForStock(stores, ' m-1033 ')).toBe('Action Auto - Orem');
    expect(storeForStock(stores, 'X55')).toBeNull();
    expect(storeForStock(stores, '')).toBeNull();
  });

  it('uses the longest matching start when two could fit', () => {
    const withWholesale: LeadStore[] = [...stores, { name: 'Wholesale', keys: ['wholesale'], stockPrefixes: ['LW'] }];
    expect(storeForStock(withWholesale, 'LW900')).toBe('Wholesale');
    expect(storeForStock(withWholesale, 'L900')).toBe('Action Auto - Lehi');
  });

  it('lets the stock number decide over the inventory store', async () => {
    mockResolveVehicle.mockResolvedValue({ vehicleId: 'car-1', location: 'LEHI', stockNumber: 'M771' });
    mockLocationFind.mockReturnValue(locationRows([
      { name: 'Action Auto - Lehi', aliasKeys: ['action auto lehi'], stockPrefixes: ['L'] },
      { name: 'Action Auto - Orem', aliasKeys: ['action auto orem'], stockPrefixes: ['M'] },
    ]));
    await expect(resolveLeadStore('org-1', { vin: 'VIN1' })).resolves.toEqual({ vehicleId: 'car-1', location: 'Action Auto - Orem', stockNumber: 'M771' });
  });

  it('uses the stock number from the lead even when the car is no longer in inventory', async () => {
    mockResolveVehicle.mockResolvedValue(null);
    mockLocationFind.mockReturnValue(locationRows([{ name: 'Action Auto - Lehi', aliasKeys: ['action auto lehi'], stockPrefixes: ['L'] }]));
    await expect(resolveLeadStore('org-1', { stock: 'l5512' })).resolves.toEqual({ location: 'Action Auto - Lehi' });
  });

  it('keeps the inventory store when no location uses that stock number start', async () => {
    mockResolveVehicle.mockResolvedValue({ vehicleId: 'car-2', location: 'OREM', stockNumber: 'Z100' });
    mockLocationFind.mockReturnValue(locationRows([{ name: 'Action Auto - Lehi', aliasKeys: ['action auto lehi'], stockPrefixes: ['L'] }]));
    await expect(resolveLeadStore('org-1', { vin: 'VIN2' })).resolves.toEqual({ vehicleId: 'car-2', location: 'OREM', stockNumber: 'Z100' });
  });

  it('does not look up locations when there is no stock number', async () => {
    mockResolveVehicle.mockResolvedValue({ vehicleId: 'car-3', location: 'LEHI' });
    await expect(resolveLeadStore('org-1', { year: '2022', make: 'Toyota', model: 'Camry' })).resolves.toEqual({ vehicleId: 'car-3', location: 'LEHI' });
    expect(mockLocationFind).not.toHaveBeenCalled();
  });
});
