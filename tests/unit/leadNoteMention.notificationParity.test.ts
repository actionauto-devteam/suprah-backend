import fs from 'fs';
import path from 'path';
import { NOTIFICATION_TYPES } from '../../src/constants/notificationTypes';
import { notificationTemplates } from '../../src/utils/notificationTemplates';

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (relative: string) => fs.readFileSync(path.join(SRC, relative), 'utf8');

describe('lead_note_mention notification registration', () => {
  it('is registered in the shared NOTIFICATION_TYPES list', () => {
    expect((NOTIFICATION_TYPES as readonly string[]).includes('lead_note_mention')).toBe(true);
  });

  it('has a category map entry and a urlMap entry in notification.service.ts', () => {
    const source = read('services/notification.service.ts');
    const occurrences = source.split('lead_note_mention').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('has a template that produces a title and message', () => {
    expect(typeof notificationTemplates.lead_note_mention).toBe('function');
    const { title, message } = notificationTemplates.lead_note_mention({
      authorName: 'Alex',
      customerName: 'Jordan Smith',
    });
    expect(title).toBeTruthy();
    expect(message).toContain('Alex');
    expect(message).toContain('Jordan Smith');
  });
});
