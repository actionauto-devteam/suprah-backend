import fs from 'fs';
import path from 'path';

describe('aiHumanAttention.service.ts escalation-note writing never touches a customer-facing send path', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/services/aiHumanAttention.service.ts'),
    'utf8',
  );

  it.each([
    'sendSmsFromUser',
    'sendAutomatedSms',
    'sendStaffAttributedSms',
    'sendVisitorMessage',
    'sendWebchatFallbackSms',
  ])('contains no reference to %s', (forbidden) => {
    expect(source).not.toContain(forbidden);
  });

  it('only ever reads message history (WebChatMessage/CommunicationMessage .find), never creates one', () => {
    expect(source).not.toMatch(/WebChatMessage\s*\.\s*create/);
    expect(source).not.toMatch(/CommunicationMessage\s*\.\s*create/);
  });

  it('writes escalation notes only through the shared, already-proven addLeadNoteAndNotify helper', () => {
    expect(source).toContain("from '../utils/leadNote'");
    expect(source).toMatch(/addLeadNoteAndNotify\(/);
  });
});
