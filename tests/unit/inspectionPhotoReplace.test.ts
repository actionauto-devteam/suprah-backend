/**
 * Replacing a car's inspection photo on a load.
 */
import fs from 'fs';
import path from 'path';
import { inspectionPhotoFilter } from '../../src/utils/inspectionPhotoReplace';

describe('inspectionPhotoFilter', () => {
  it('saves only for the same car, in the same place, with the same photo', () => {
    expect(inspectionPhotoFilter('l1', 'org-1', 1, { vin: '1HGCM82633A123456', inspectionPhotoUrl: 'load-inspection/old.jpg' })).toEqual({
      _id: 'l1',
      organizationId: 'org-1',
      'vehicles.1': { $exists: true },
      'vehicles.1.vin': '1HGCM82633A123456',
      'vehicles.1.inspectionPhotoUrl': 'load-inspection/old.jpg',
    });
  });

  it('matches a car with no photo yet, and one without a VIN', () => {
    expect(inspectionPhotoFilter('l1', 'org-1', 0, {})).toEqual({
      _id: 'l1',
      organizationId: 'org-1',
      'vehicles.0': { $exists: true },
      'vehicles.0.inspectionPhotoUrl': { $in: ['', null] },
    });
  });
});

describe('uploadInspectionPhoto', () => {
  const controller = fs.readFileSync(path.join(__dirname, '../../src/controllers/load.controller.ts'), 'utf8');
  const handler = controller.slice(controller.indexOf('const uploadInspectionPhoto'), controller.indexOf('const uploadInspectionPhoto') + 3000);

  it('stores the new photo before saving, and deletes the old one only after saving', () => {
    const upload = handler.indexOf('storageService.upload(file, "load-inspection"');
    const save = handler.indexOf('Load.findOneAndUpdate(');
    const deleteOld = handler.indexOf('storageService.delete(existing');
    expect(upload).toBeGreaterThan(-1);
    expect(upload).toBeLessThan(save);
    expect(save).toBeLessThan(deleteOld);
    expect(handler).not.toContain('load.save()');
  });

  it('removes its own upload when the car changed meanwhile', () => {
    expect(handler).toMatch(/if \(!updated\) \{\s+try \{ await storageService\.delete\(imageUrl, BucketType\.PRIVATE\); \}/);
  });
});
