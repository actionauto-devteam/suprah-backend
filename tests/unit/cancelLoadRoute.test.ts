/**
 * Cancel load is a staff action. Reads the route file directly so no
 * controllers load.
 */
import fs from 'fs';
import path from 'path';

const driverTracking = fs
  .readFileSync(path.join(__dirname, '../../src/routes/driverTracking.routes.ts'), 'utf8')
  .replace(/\s+/g, ' ');

describe('cancel load route', () => {
  it('is staff only and never cached', () => {
    expect(driverTracking).toContain(
      'router.post( "/loads/:id/cancel", staffOnly, noStoreSensitive, driverTrackingController.cancelLoad, );',
    );
  });

  it("doesn't clash with the driver's release request cancel", () => {
    expect(driverTracking).toContain('router.post( "/loads/:id/release-request/cancel", driverOnly,');
  });
});
