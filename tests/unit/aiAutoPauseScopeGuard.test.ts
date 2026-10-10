import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (relative: string) => fs.readFileSync(path.join(SRC, relative), 'utf8');

/**
 * Stage 34's auto-pause-on-human-takeover feature must only ever be recorded
 * from the staff-only UI-triggered controllers (sendMessage, replyToConversation,
 * sendStaffMessage) — never from the shared sendSmsFromUser/sendStaffAttributedSms
 * functions in communication.service.ts, since those are also used by every
 * automated sender (reminders, nurture, review requests, campaigns, and Alex's
 * own sends). If this guard ever fails, an automated send would incorrectly be
 * treated as a human taking over the conversation from Alex.
 */
describe('aiAutoPause scope guard', () => {
  it('communication.service.ts never imports or calls recordHumanTakeover', () => {
    const source = read('services/communication.service.ts');
    expect(source).not.toMatch(/recordHumanTakeover/);
    expect(source).not.toMatch(/from ['"]\.\.\/utils\/aiAutoPause['"]/);
  });

  it('the staff-send controllers do call recordHumanTakeover', () => {
    const commController = read('controllers/communication.controller.ts');
    const webchatController = read('controllers/webchat.controller.ts');
    expect(commController).toMatch(/recordHumanTakeover/);
    expect(webchatController).toMatch(/recordHumanTakeover/);

    // Specifically inside sendMessage and replyToConversation, not just imported.
    const sendMessageBody = commController.slice(commController.indexOf('export const sendMessage'));
    const replyBody = commController.slice(
      commController.indexOf('export const replyToConversation'),
      commController.indexOf('export const pauseSmsAi'),
    );
    expect(sendMessageBody.slice(0, 800)).toMatch(/recordHumanTakeover/);
    expect(replyBody).toMatch(/recordHumanTakeover/);

    const sendStaffMessageBody = webchatController.slice(
      webchatController.indexOf('export const sendStaffMessage'),
      webchatController.indexOf('export const pauseWebchatAi'),
    );
    expect(sendStaffMessageBody).toMatch(/recordHumanTakeover/);
  });
});
