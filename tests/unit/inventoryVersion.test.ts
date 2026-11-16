/**
 * The Inventory page's "has anything changed?" stamp.
 */
import fs from 'fs';
import path from 'path';
import { inventoryVersion, newestChange } from '../../src/utils/inventoryVersion';

const NOW = new Date('2026-11-16T05:42:10.000Z');

describe('inventoryVersion', () => {
  it('combines the car count, the newest change and the hour', () => {
    expect(inventoryVersion(42, new Date('2026-11-16T05:00:00.000Z'), NOW)).toBe('42:1794805200000:2026-11-16T05');
  });

  it('changes when a car is added or removed, a car changes, or the hour turns', () => {
    const base = inventoryVersion(42, new Date(1000), NOW);
    expect(inventoryVersion(41, new Date(1000), NOW)).not.toBe(base);
    expect(inventoryVersion(42, new Date(2000), NOW)).not.toBe(base);
    expect(inventoryVersion(42, new Date(1000), new Date('2026-11-16T06:00:00.000Z'))).not.toBe(base);
    expect(inventoryVersion(42, new Date(1000), new Date('2026-11-16T05:59:59.000Z'))).toBe(base);
  });

  it('copes with an empty inventory', () => {
    expect(inventoryVersion(0, null, NOW)).toBe('0:0:2026-11-16T05');
  });
});

describe('newestChange', () => {
  it('finds the newest change time', () => {
    expect(newestChange([{ updatedAt: '2026-11-01T00:00:00Z' }, { updatedAt: new Date('2026-11-03T00:00:00Z') }, {}])?.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(newestChange([])).toBeNull();
  });
});

describe('inventory version route', () => {
  it('is registered before the car-by-id route, for staff only', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../../src/routes/vehicle.route.ts'), 'utf8');
    const version = routes.indexOf("router.get('/inventory-version', staffOnly, vehicleController.getInventoryVersion);");
    expect(version).toBeGreaterThan(-1);
    expect(version).toBeLessThan(routes.indexOf(".route('/:id')"));
  });

  it('counts the same cars as the full inventory list', () => {
    const controller = fs.readFileSync(path.join(__dirname, '../../src/controllers/vehicle.controller.ts'), 'utf8');
    expect(controller).toContain('{ $match: { organizationId: req.orgId, isDeleted: false, ...archivedScope(req.query.archived) } }');
    expect(controller).toContain('pipeline.push({ $match: { organizationId: req.orgId, isDeleted: false } });');
    expect(controller).toContain('const filter: any = { isDeleted: false, ...archivedScope(archived) };');
  });
});
