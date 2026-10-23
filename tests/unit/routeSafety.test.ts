import { legSafety, listOf } from '../../src/services/routeSafety.service';

const notice = (Code: string, ViolatedConstraints?: Record<string, unknown>, Impact = 'High') => ({
  Code,
  Impact,
  Details: ViolatedConstraints ? [{ Title: 'Limit', ViolatedConstraints }] : [],
});

describe('route safety check', () => {
  it('a route with no notices, or only notices about tolls and the like, is fine', () => {
    expect(legSafety(undefined)).toEqual({ status: 'ok', limits: [] });
    expect(legSafety([])).toEqual({ status: 'ok', limits: [] });
    expect(
      legSafety([notice('TollsDataUnavailable'), notice('AccuratePolylineUnavailable'), notice('TravelTimeExceedsDriverWorkHours')]),
    ).toEqual({ status: 'ok', limits: [] });
  });

  it('a broken limit makes the route unsafe and names the limit in US units', () => {
    expect(legSafety([notice('ViolatedVehicleRestriction', { MaxHeight: 381 })])).toEqual({
      status: 'unsafe',
      limits: ['a 12 ft 6 in height limit'],
    });
    expect(legSafety([notice('ViolatedVehicleRestriction', { MaxLength: 1829, MaxWidth: 244 })]).limits).toEqual([
      'a 60 ft length limit',
      'an 8 ft width limit',
    ]);
    expect(legSafety([notice('ViolatedVehicleRestriction', { MaxWeight: { Type: 'Gross', Value: 18_144 } })]).limits).toEqual([
      'a 40,000 lb weight limit',
    ]);
    expect(legSafety([notice('ViolatedVehicleRestriction', { MaxWeightPerAxle: 4_000 })]).limits).toEqual([
      'an 8,800 lb per-axle weight limit',
    ]);
  });

  it('a limit that may apply asks the driver to check the route', () => {
    expect(legSafety([notice('PotentialViolatedVehicleRestrictionUsage', { MaxHeight: 411 }, 'Low')])).toEqual({
      status: 'check',
      limits: ['a 13 ft 6 in height limit'],
    });
    expect(legSafety([notice('SeasonalClosure')])).toEqual({ status: 'check', limits: ['a road that may be closed for the season'] });
  });

  it('a broken limit wins over one that may apply', () => {
    const safety = legSafety([
      notice('PotentialViolatedVehicleRestrictionUsage', { MaxHeight: 411 }),
      notice('ViolatedBlockedRoad'),
    ]);
    expect(safety).toEqual({ status: 'unsafe', limits: ['a 13 ft 6 in height limit', 'a blocked road'] });
  });

  it('names the kind of limit when Amazon gives no numbers', () => {
    const limitsFor = (code: string) => legSafety([notice(code)]).limits;
    expect(limitsFor('ViolatedBlockedRoad')).toEqual(['a blocked road']);
    expect(limitsFor('ViolatedTurnRestriction')).toEqual(["a turn trucks can't make"]);
    expect(limitsFor('PotentialViolatedZoneRestrictionUsage')).toEqual(["an area trucks can't enter"]);
    expect(limitsFor('ViolatedAvoidTruckRoadType')).toEqual(["a road trucks shouldn't use"]);
    expect(limitsFor('ViolatedEmergencyGate')).toEqual(['an emergency gate']);
    expect(limitsFor('ViolatedVehicleRestriction')).toEqual(['a road with truck limits']);
  });

  it('lists each limit once and at most three', () => {
    const safety = legSafety([
      notice('ViolatedVehicleRestriction', { MaxHeight: 381 }),
      notice('ViolatedVehicleRestriction', { MaxHeight: 381 }),
      notice('ViolatedVehicleRestriction', { MaxLength: 1829 }),
      notice('ViolatedBlockedRoad'),
      notice('ViolatedEmergencyGate'),
    ]);
    expect(safety.limits).toEqual(['a 12 ft 6 in height limit', 'a 60 ft length limit', 'a blocked road']);
  });

  it('ignores notices it cannot read', () => {
    expect(legSafety([null, 'text', { Code: 42 }, { Details: 'none' }])).toEqual({ status: 'ok', limits: [] });
    expect(legSafety([notice('ViolatedVehicleRestriction', { MaxHeight: -1, MaxWeight: { Value: 'heavy' } })]).limits).toEqual([
      'a road with truck limits',
    ]);
  });

  it('joins limits into one sentence', () => {
    expect(listOf([])).toBe('');
    expect(listOf(['a'])).toBe('a');
    expect(listOf(['a', 'b'])).toBe('a and b');
    expect(listOf(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
