/**
 * The rate limits sit on the routes that notify people or store files, and
 * never on driver heartbeats or location updates (a limit there would break
 * live tracking). Reads the route files directly so no controllers load.
 */
import fs from 'fs';
import path from 'path';

const routeFile = (name: string) =>
  fs.readFileSync(path.join(__dirname, '../../src/routes', name), 'utf8').replace(/\s+/g, ' ');

const driverTracking = routeFile('driverTracking.routes.ts');
const dispatchChannel = routeFile('dispatchChannel.routes.ts');
const quotes = routeFile('quote.routes.ts');

describe('rate limits on routes', () => {
  it.each([
    'router.post("/loads/:id/request", driverOnly, driverLoadRequestLimiter,',
    'router.post( "/loads/:id/release-request", driverOnly, driverLoadRequestLimiter,',
    'router.post( "/loads/:id/release-request/cancel", driverOnly, driverLoadRequestLimiter,',
    'router.post("/loads/:id/drop", driverOnly, driverLoadRequestLimiter,',
    'router.post( "/dispatch-chat/:driverId/messages", dispatchChatMessageLimiter,',
    'router.post( "/dispatch-chat/:driverId/attachments", dispatchChatUploadLimiter, uploadDispatchChatFiles,',
  ])('Driver Tracker: %s', (expected) => {
    expect(driverTracking).toContain(expected);
  });

  it.each([
    '.post(dispatchChatMessageLimiter, dispatchChannelController.sendMessage)',
    'router.post("/:id/attachments", dispatchChatUploadLimiter, uploadDispatchChatFiles,',
  ])('Dispatch channels: %s', (expected) => {
    expect(dispatchChannel).toContain(expected);
  });

  it.each([
    '.post(quoteChangeLimiter, quoteController.createQuote)',
    '.patch(quoteChangeLimiter, quoteController.updateQuoteStatus)',
    '.post(quoteChangeLimiter, quoteController.convertToLoad)',
  ])('Quotes: %s', (expected) => {
    expect(quotes).toContain(expected);
  });

  it('leaves driver heartbeats and location updates unlimited', () => {
    expect(driverTracking).toContain('router.post("/heartbeat", driverOnly, driverTrackingController.heartbeat);');
    const offline = driverTracking.match(/router\.post\( "\/location-offline",[^;]*;/)?.[0] ?? '';
    expect(offline).not.toBe('');
    expect(offline).not.toMatch(/Limiter/);
  });
});
