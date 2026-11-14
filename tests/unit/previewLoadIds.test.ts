/**
 * The compatibility preview fetches its saved loads in one lookup.
 */
import fs from 'fs';
import path from 'path';
import { previewLoadIds } from '../../src/utils/previewLoadIds';

const A = '64b0000000000000000000a1';
const B = '64b0000000000000000000b2';

describe('previewLoadIds', () => {
  it('keeps valid load IDs once each, in order', () => {
    expect(previewLoadIds([{ loadId: A }, { loadId: B }, { loadId: A }, { loadId: ` ${B} ` }])).toEqual([A, B]);
  });

  it('skips drafts without an ID and anything that is not a load ID', () => {
    expect(previewLoadIds([{}, null, { loadId: '' }, { loadId: 'not-an-id' }, { loadId: { $ne: null } }])).toEqual([]);
  });
});

describe('compatibility preview', () => {
  it('looks the saved loads up once, in this dealership only', () => {
    const controller = fs.readFileSync(path.join(__dirname, '../../src/controllers/driverTracking.controller.ts'), 'utf8');
    expect(controller).toContain('await Load.find({ _id: { $in: savedIds }, organizationId }).lean()');
    expect(controller).not.toMatch(/for \(const entry of entries\) \{[\s\S]{0,400}await Load\.findOne/);
  });
});
