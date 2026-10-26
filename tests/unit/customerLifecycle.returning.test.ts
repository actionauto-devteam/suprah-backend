import { findReturningVisits, isSoldStatus, soldStatusDate } from '../../src/services/customerLifecycle.service';

const d = (day: number) => new Date(Date.UTC(2026, 8, day, 12));

describe('findReturningVisits', () => {
    it('flags a new lead created after an earlier lead was closed', () => {
        const visits = findReturningVisits([
            { _id: 'a', createdAt: d(1), statusHistory: [{ from: 'New', to: 'Bought Elsewhere', changedAt: d(3) }] },
            { _id: 'b', createdAt: d(10), statusHistory: [] },
        ]);
        expect(visits).toEqual([{ leadId: 'b', at: d(10), previousLeadId: 'a', previousStatus: 'Bought Elsewhere', previousClosedAt: d(3) }]);
    });

    it('does not flag a lead that arrived while the earlier lead was still open', () => {
        expect(findReturningVisits([
            { _id: 'a', createdAt: d(1), statusHistory: [{ from: 'New', to: 'Sold', changedAt: d(12) }] },
            { _id: 'b', createdAt: d(10) },
        ])).toEqual([]);
    });

    it('does not flag a lead when the earlier lead had been reopened first', () => {
        expect(findReturningVisits([
            { _id: 'a', createdAt: d(1), statusHistory: [{ from: 'New', to: 'Sold', changedAt: d(3) }, { from: 'Sold', to: 'Working', changedAt: d(5) }] },
            { _id: 'b', createdAt: d(10) },
        ])).toEqual([]);
    });

    it('ignores closures and leads without a recorded date', () => {
        expect(findReturningVisits([
            { _id: 'a', createdAt: d(1), statusHistory: [{ from: 'New', to: 'Sold' }] },
            { _id: 'b', createdAt: d(10) },
            { _id: 'c' },
        ])).toEqual([]);
    });

    it('uses only the current Sold-type status date for leads marked sold', () => {
        expect(isSoldStatus('Sold')).toBe(true);
        expect(isSoldStatus('Contacted')).toBe(false);
        expect(soldStatusDate({ status: 'Sold', statusHistory: [{ to: 'Sold', changedAt: d(3) }, { to: 'Working', changedAt: d(4) }, { to: 'Sold', changedAt: d(6) }] })).toEqual(d(6));
        expect(soldStatusDate({ status: 'Sold', statusHistory: [] })).toBeNull();
    });
});
