import { groupDuplicateLeads, GroupableLead } from '../../src/services/leadDuplicateCombine.service';

const lead = (leadId: string, phone: string | null, email: string | null, createdAt?: string): GroupableLead => ({
  leadId,
  phone,
  email,
  createdAt: createdAt ? new Date(createdAt) : null,
});

describe('groupDuplicateLeads', () => {
  it('groups leads that share a phone or an email and puts the newest first', () => {
    const groups = groupDuplicateLeads([
      lead('a', '+18015550101', 'kiran@example.com', '2026-10-27T10:00:00Z'),
      lead('b', '+18015550101', null, '2026-10-29T10:00:00Z'),
      lead('c', null, 'kiran@example.com', '2026-10-28T10:00:00Z'),
    ]);
    expect(groups).toEqual([['b', 'c', 'a']]);
  });

  it('follows chains: a shared phone and then a shared email make one customer', () => {
    const groups = groupDuplicateLeads([
      lead('a', '+18015550101', 'one@example.com', '2026-10-01T00:00:00Z'),
      lead('b', '+18015550101', 'two@example.com', '2026-10-02T00:00:00Z'),
      lead('c', '+18015550199', 'two@example.com', '2026-10-03T00:00:00Z'),
    ]);
    expect(groups).toEqual([['c', 'b', 'a']]);
  });

  it('never groups by name or by missing details', () => {
    expect(groupDuplicateLeads([
      lead('a', null, null),
      lead('b', null, null),
      lead('c', '+18015550101', 'one@example.com'),
      lead('d', '+18015550102', 'two@example.com'),
    ])).toEqual([]);
  });

  it('keeps separate customers in separate groups', () => {
    const groups = groupDuplicateLeads([
      lead('a1', '+18015550101', null, '2026-10-01T00:00:00Z'),
      lead('a2', '+18015550101', null, '2026-10-02T00:00:00Z'),
      lead('b1', null, 'b@example.com', '2026-10-01T00:00:00Z'),
      lead('b2', null, 'b@example.com', '2026-10-03T00:00:00Z'),
      lead('solo', '+18015550177', 'solo@example.com'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups).toEqual(expect.arrayContaining([['a2', 'a1'], ['b2', 'b1']]));
  });

  it('uses the lead id time when the created date is missing', () => {
    const groups = groupDuplicateLeads([
      lead('65f000000000000000000001', '+18015550101', null),
      lead('66f000000000000000000001', '+18015550101', null),
    ]);
    expect(groups).toEqual([['66f000000000000000000001', '65f000000000000000000001']]);
  });
});
