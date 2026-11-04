/**
 * The live map request is for signed-in customer accounts only, rate
 * limited, and never cached. Reads the route file directly so no controllers load.
 */
import fs from 'fs';
import path from 'path';

const routes = fs
  .readFileSync(path.join(__dirname, '../../src/routes/customerQuoteRequest.routes.ts'), 'utf8')
  .replace(/\s+/g, ' ');

describe('live map route', () => {
  it('is for customer accounts only, with its own rate limit', () => {
    expect(routes).toContain(
      'router.get( "/:id/tracking", authorize("customer", "The live map is for the customer receiving the vehicle. Staff see the driver on Driver Tracker."), customerTrackingLimiter, quoteController.getShipmentTracking, );',
    );
  });

  it('comes after sign-in and the no-cache header', () => {
    const signIn = routes.indexOf('router.use(auth());');
    const noStore = routes.indexOf('"private, no-store, max-age=0"');
    const tracking = routes.indexOf('"/:id/tracking"');
    expect(signIn).toBeGreaterThan(-1);
    expect(noStore).toBeGreaterThan(signIn);
    expect(tracking).toBeGreaterThan(noStore);
  });
});
