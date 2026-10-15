jest.mock('../../src/utils/signedUrlCache', () => ({
  getSignedProofUrl: jest.fn(async (key: string) => `https://signed.example/${key}`),
}));

import {
  assertConditionStopEditable,
  editableConditionStops,
  omitConditionReportsFromList,
  parseConditionStop,
  parseDeliverySignature,
  parseVehicleIndex,
  presentConditionReportsForStaff,
  sanitizeConditionDetails,
} from '../../src/services/loadConditionReport.service';

describe('condition report rules', () => {
  it('accepts only the pickup and delivery stops', () => {
    expect(parseConditionStop('pickup')).toBe('pickup');
    expect(parseConditionStop('delivery')).toBe('delivery');
    expect(() => parseConditionStop('somewhere')).toThrow(/pickup or the delivery/);
  });

  it('accepts only a vehicle that is on the load', () => {
    expect(parseVehicleIndex('1', 2)).toBe(1);
    expect(() => parseVehicleIndex('2', 2)).toThrow(/no longer on this load/);
    expect(() => parseVehicleIndex('-1', 2)).toThrow();
    expect(() => parseVehicleIndex('x', 2)).toThrow();
  });

  it('opens pickup from acceptance until the route starts, and delivery until delivered', () => {
    expect(editableConditionStops('Assigned')).toEqual([]);
    expect(editableConditionStops('Accepted')).toEqual(['pickup']);
    expect(editableConditionStops('Picked Up')).toEqual(['pickup', 'delivery']);
    expect(editableConditionStops('In-Transit')).toEqual(['delivery']);
    expect(editableConditionStops('Delivered')).toEqual([]);
    expect(() => assertConditionStopEditable('pickup', 'In-Transit', 'LD-1')).toThrow(/until you start the route/);
    expect(() => assertConditionStopEditable('delivery', 'Delivered', 'LD-1')).toThrow(/until the load is delivered/);
  });

  it('keeps only known damage areas and kinds, without repeats, and trims the note', () => {
    expect(
      sanitizeConditionDetails({
        damageAreas: ['hood', 'hood', 'spaceship', 'left_front'],
        damageTypes: ['dent', 'explosion'],
        note: `  ${'x'.repeat(1200)}  `,
      }),
    ).toEqual({ damageAreas: ['hood', 'left_front'], damageTypes: ['dent'], note: 'x'.repeat(1000) });
    expect(sanitizeConditionDetails(null)).toEqual({ damageAreas: [], damageTypes: [], note: '' });
  });

  it('needs a name and a drawn PNG signature', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(parseDeliverySignature({ signerName: ' Pat Customer ', signatureDataUrl: png })).toEqual({
      signerName: 'Pat Customer',
      signatureDataUrl: png,
    });
    expect(() => parseDeliverySignature({ signerName: '', signatureDataUrl: png })).toThrow(/name of the person/);
    expect(() => parseDeliverySignature({ signerName: 'Pat', signatureDataUrl: 'javascript:alert(1)' })).toThrow(
      /sign in the box/,
    );
    expect(() =>
      parseDeliverySignature({ signerName: 'Pat', signatureDataUrl: `data:image/png;base64,${'A'.repeat(300_001)}` }),
    ).toThrow(/too large/);
  });

  it('shows Dispatch photo links, never the storage keys', async () => {
    const load: Record<string, any> = {
      conditionReports: [
        {
          _id: 'r1',
          stop: 'pickup',
          vehicleIndex: 0,
          driverId: 'd1',
          driverName: 'Sam',
          photos: [{ _id: 'p1', key: 'condition-report/a.jpg', uploadedAt: '2026-10-13T10:00:00Z' }],
          damageAreas: ['hood'],
          damageTypes: ['dent'],
          note: 'Small dent',
        },
      ],
    };
    await presentConditionReportsForStaff(load);
    expect(load.conditionReports[0].photos).toEqual([
      { id: 'p1', url: 'https://signed.example/condition-report/a.jpg', uploadedAt: '2026-10-13T10:00:00Z' },
    ]);
    expect(JSON.stringify(load)).not.toContain('"key"');
  });

  it('leaves condition reports and the signature drawing out of load lists', () => {
    const load: Record<string, any> = {
      conditionReports: [{ photos: [] }],
      deliverySignature: { signerName: 'Pat', signatureDataUrl: 'data:image/png;base64,AAA', signedAt: 'now' },
    };
    omitConditionReportsFromList(load);
    expect(load).toEqual({ deliverySignature: { signerName: 'Pat', signedAt: 'now' } });
  });
});
