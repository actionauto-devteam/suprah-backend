import { cleanTrace, distanceMeters, simplifyLine, TracePoint } from '../../src/services/routeTrace.service';

const t0 = Date.UTC(2026, 9, 5, 15, 0, 0);
// About 111 m per 0.001° of latitude.
const pt = (seconds: number, lat: number, lng = -105, extra: Partial<TracePoint> = {}): TracePoint => ({
  lat,
  lng,
  measuredAt: new Date(t0 + seconds * 1000),
  accuracy: 10,
  source: 'app',
  ...extra,
});

describe('route line cleaning', () => {
  it('keeps one reading per moment (the most precise) in time order', () => {
    const cleaned = cleanTrace([pt(20, 40.002), pt(0, 40.0, -105, { accuracy: 30 }), pt(0, 40.0001, -105, { accuracy: 5 }), pt(10, 40.001)]);
    expect(cleaned.map((point) => point.measuredAt.getTime() - t0)).toEqual([0, 10_000, 20_000]);
    expect(cleaned[0].accuracy).toBe(5);
  });

  it('uses only phone readings when the phone reported, and drops rough readings', () => {
    const cleaned = cleanTrace([
      pt(0, 40.0),
      pt(5, 40.5, -104, { source: 'browser', accuracy: 50_000 }),
      pt(10, 40.001),
      pt(20, 40.002, -105, { accuracy: 250 }),
      pt(30, 40.003),
    ]);
    expect(cleaned.map((point) => point.lat)).toEqual([40.0, 40.001, 40.003]);

    // Without phone readings, precise browser readings are used.
    const browserOnly = cleanTrace([pt(0, 40, -105, { source: 'browser' }), pt(30, 40.001, -105, { source: 'browser' })]);
    expect(browserOnly).toHaveLength(2);
  });

  it('drops a single impossible jump but keeps a move confirmed by the next reading', () => {
    // 40.0 -> 41.0 (111 km in 10 s) -> back to the road: the jump is a glitch.
    expect(cleanTrace([pt(0, 40.0), pt(10, 41.0), pt(20, 40.0015)]).map((point) => point.lat)).toEqual([40.0, 40.0015]);
    // A jump that two agreeing readings confirm is kept (for example the
    // phone's earlier fixes were off and it corrected itself).
    const moved = cleanTrace([pt(0, 40.0), pt(5, 40.0004), pt(10, 40.5), pt(20, 40.5005)]);
    expect(moved.map((point) => point.lat)).toEqual([40.0, 40.0004, 40.5, 40.5005]);
    // A long gap at driving speed is simply a normal reading.
    expect(cleanTrace([pt(0, 40.0), pt(3600, 40.5)])).toHaveLength(2);
  });

  it('drops a glitch at the very start', () => {
    expect(cleanTrace([pt(0, 45.0), pt(10, 40.0), pt(20, 40.001)]).map((point) => point.lat)).toEqual([40.0, 40.001]);
  });
});

describe('route line simplifying', () => {
  it('keeps the corners and both ends while removing points on straight stretches', () => {
    const line: Array<{ lat: number; lng: number }> = [];
    for (let i = 0; i <= 50; i += 1) line.push({ lat: 40 + i * 0.0001, lng: -105 }); // north
    for (let i = 1; i <= 50; i += 1) line.push({ lat: 40.005, lng: -105 + i * 0.0001 }); // then east
    const simplified = simplifyLine(line, 10);
    expect(simplified.length).toBeLessThanOrEqual(10);
    expect(simplified[0]).toEqual(line[0]);
    expect(simplified.at(-1)).toEqual(line.at(-1));
    // The corner where the road turns east is still there.
    expect(simplified.some((point) => distanceMeters(point, { lat: 40.005, lng: -105 }) < 1)).toBe(true);
  });

  it('returns short lines unchanged', () => {
    const line = [{ lat: 40, lng: -105 }, { lat: 40.1, lng: -105 }];
    expect(simplifyLine(line, 10)).toBe(line);
  });
});
