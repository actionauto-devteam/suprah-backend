import fs from 'fs';
import path from 'path';
import {
  LOCATION_LIMITS,
  computeAliasKeys,
  locationAccess,
  locationLabelIssues,
  normalizeLocationKey,
  parseLocationInput,
} from '../../src/services/crmLocation.service';

const SRC = path.resolve(__dirname, '../../src');
const read = (relative: string) => fs.readFileSync(path.join(SRC, relative), 'utf8');

describe('location keys', () => {
  it.each([
    ['Orem', 'orem'],
    ['  OREM  ', 'orem'],
    ['Orem, UT', 'orem ut'],
    ['orem-ut', 'orem ut'],
    ['Orém', 'orem'],
    ['American  Fork', 'american fork'],
  ])('normalizes %p to %p', (input, expected) => {
    expect(normalizeLocationKey(input)).toBe(expected);
  });

  it('combines name, code and aliases into unique keys', () => {
    expect(computeAliasKeys('orem', 'Orem', ['OREM', 'Orem UT', 'orem-ut'])).toEqual(['orem', 'orem ut']);
  });
});

describe('location input validation', () => {
  it('accepts a valid new location and cleans aliases', () => {
    const { value, issues } = parseLocationInput({ code: 'Lehi-Main', name: '  Lehi   Main ', aliases: ['Lehi', 'LEHI', '', 'Lehi UT'] }, 'create');
    expect(issues).toEqual([]);
    expect(value).toEqual({ code: 'lehi-main', name: 'Lehi Main', aliases: ['Lehi', 'Lehi UT'] });
  });

  it.each([
    [{ name: 'Orem' }, 'code'],
    [{ code: 'orem' }, 'name'],
    [{ code: '-orem', name: 'Orem' }, 'code'],
    [{ code: 'orem lot', name: 'Orem' }, 'code'],
    [{ code: 'o', name: 'Orem' }, 'code'],
    [{ code: 'orem', name: 'O' }, 'name'],
    [{ code: 'orem', name: 'x'.repeat(81) }, 'name'],
    [{ code: 'orem', name: 'Orem', aliases: 'Orem' }, 'aliases'],
  ])('rejects %p', (input, field) => {
    expect(parseLocationInput(input, 'create').issues.map((issue) => issue.field)).toContain(field);
  });

  it.each([
    ['Orem 801-555-1234', 'contact_info'],
    ['orem@dealer.com', 'contact_info'],
    ['www.dealer.com', 'contact_info'],
    ['Lot 1234567', 'contact_info'],
    ['1HGCM82633A004352', 'record_reference'],
    ['507f1f77bcf86cd799439011', 'record_reference'],
    ['Orem <script>', 'invalid_characters'],
    ['---', 'invalid_characters'],
  ])('rejects the label %p', (label, code) => {
    expect(locationLabelIssues('name', 'Name', label).map((issue) => issue.code)).toEqual([code]);
  });

  it.each(['Orem', 'American Fork', "St. George's Lot #2", 'Provo (North)', 'Salt Lake City / Downtown'])('accepts the label %p', (label) => {
    expect(locationLabelIssues('name', 'Name', label)).toEqual([]);
  });

  it('limits the number of aliases', () => {
    const aliases = Array.from({ length: LOCATION_LIMITS.aliases + 1 }, (_, i) => `Alias ${String.fromCharCode(65 + i)}`);
    expect(parseLocationInput({ code: 'orem', name: 'Orem', aliases }, 'create').issues.map((issue) => issue.code)).toContain('too_many');
  });

  it('treats a code in an update as a value to compare, not a new code', () => {
    expect(parseLocationInput({ code: 'orem', name: 'Orem North' }, 'update').value).toEqual({ code: 'orem', name: 'Orem North' });
    expect(parseLocationInput({ name: 'Orem North' }, 'update').value).toEqual({ name: 'Orem North' });
  });

  it.each([null, 'text', 42, []])('rejects a malformed body %p', (raw) => {
    expect(parseLocationInput(raw, 'create').issues.map((issue) => issue.code)).toContain('invalid_type');
  });
});

describe('location access', () => {
  it.each([
    ['admin', 'admin'],
    ['super_admin', 'admin'],
    ['manager', 'manager'],
    ['employee', 'none'],
    ['', 'none'],
  ])('role %p has %p access', (role, access) => {
    expect(locationAccess({ role })).toBe(access);
  });
});

describe('location module isolation', () => {
  const files = ['services/crmLocation.service.ts', 'controllers/crmLocation.controller.ts', 'routes/crmLocation.routes.ts'];

  it.each(files)('%s never writes to leads, vehicles or organizations', (file) => {
    const source = read(file);
    expect(source).not.toMatch(/\b(Lead|Vehicle|Organization)\.(create|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|replaceOne|deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|bulkWrite)\b/);
    expect(source).not.toMatch(/\.save\(/);
  });

  it.each(files)('%s never reaches senders, AI generation or Gemini', (file) => {
    const source = read(file);
    for (const token of ['communication.service', 'email.service', 'notification', 'aiAgent', 'aiShadowDraft', 'aiAgentCoaching', 'createGeminiClient', 'openai', 'telnyx']) {
      expect(source).not.toContain(token);
    }
  });

  it('existing location behavior is untouched by the new module', () => {
    for (const file of ['services/leadLocation.service.ts', 'utils/vehicleMatch.ts', 'models/Place.model.ts']) {
      if (fs.existsSync(path.join(SRC, file))) expect(read(file)).not.toContain('CrmLocation');
    }
  });

  it('is mounted before the generic /crm router', () => {
    const routes = read('routes/index.ts');
    expect(routes.indexOf('path: "/crm/locations"')).toBeGreaterThan(-1);
    expect(routes.indexOf('path: "/crm/locations"')).toBeLessThan(routes.indexOf('path: "/crm",'));
  });
});
