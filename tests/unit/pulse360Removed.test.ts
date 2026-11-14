/**
 * Pulse 360 is switched off (2026-11-15): its routes are no longer mounted.
 * Its saved data in the database is left as it is.
 */
import fs from 'fs';
import path from 'path';

describe('Pulse 360 is switched off', () => {
  const routes = fs.readFileSync(path.join(__dirname, '../../src/routes/index.ts'), 'utf8');

  it('no longer mounts the /api/crm/pulse360 routes', () => {
    expect(routes).not.toMatch(/pulse360/i);
  });

  it('keeps the other dedicated CRM prefixes above /crm', () => {
    expect(routes).toContain('path: "/crm/stories"');
  });
});
