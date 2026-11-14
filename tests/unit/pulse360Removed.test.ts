/**
 * Pulse 360 is switched off (2026-11-15): its routes are no longer mounted.
 * Its saved data in the database is left as it is.
 */
import fs from 'fs';
import path from 'path';

const FILES = [
  'controllers/pulse360.controller.ts',
  'routes/pulse360.route.ts',
  'services/pulse360.service.ts',
  'services/pulse360.rules.ts',
  'services/pulse360.scoring.ts',
  'services/pulse360.taskAdapter.ts',
  'jobs/pulse360.scheduler.ts',
  'socket/pulse360.socket.ts',
  'middleware/pulseTrack.middleware.ts',
  'models/PulseAlert.model.ts',
  'models/PulseHealth.model.ts',
  'models/PulseSetting.model.ts',
  'models/PulseSignal.model.ts',
];

describe('Pulse 360 code is removed', () => {
  it.each(FILES)('%s is gone', (rel) => {
    expect(fs.existsSync(path.join(__dirname, '../../src', rel))).toBe(false);
  });
});

describe('Pulse 360 is switched off', () => {
  const routes = fs.readFileSync(path.join(__dirname, '../../src/routes/index.ts'), 'utf8');

  it('no longer mounts the /api/crm/pulse360 routes', () => {
    expect(routes).not.toMatch(/pulse360/i);
  });

  it('keeps the other dedicated CRM prefixes above /crm', () => {
    expect(routes).toContain('path: "/crm/stories"');
  });
});
