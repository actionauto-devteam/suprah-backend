import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (relative: string) => fs.readFileSync(path.join(SRC, relative), 'utf8');

describe('staff AI draft scope guard', () => {
  const source = read('services/aiAgentDraft.service.ts');

  it('never imports a send path, the Alex turn runner, or the conversation log', () => {
    expect(source).not.toMatch(/sendSms|sendSmsFromUser|sendStaffAttributedSms|sendAutomatedSms|telnyx/i);
    expect(source).not.toMatch(/sendLeadReplyEmail|sendEmail|gmail/i);
    expect(source).not.toMatch(/sendStaffMessage|WebChatMessage|CommunicationMessage/);
    expect(source).not.toMatch(/processAlexTurn|AiAgentLog|AiAgentDraft\.model/);
  });

  it('never writes pause, takeover or lead state', () => {
    expect(source).not.toMatch(/aiPausedAt|aiPausedBy|aiAutoPausedUntil|aiGeneratingAt|recordHumanTakeover/);
    expect(source).not.toMatch(/\.save\(|\.create\(|updateOne|updateMany|findOneAndUpdate|insertMany|deleteOne|bulkWrite/);
    expect(source).not.toMatch(/emitToOrg|emitToUser|notifyUsers|notifyOrgAdmins/);
  });

  it('does not depend on or change the automatic AI mode', () => {
    expect(source).not.toMatch(/decideAiDelivery|assertAiDispatchAllowed|resolveAiChannelMode|resolveAiAgentSettings|aiAgentModes|aiAgentEnabled|AI_AGENT_ENABLED/);
  });

  it('records usage through the shared counter only', () => {
    expect(source).toMatch(/recordAiUsage\(organizationId, 'staff_draft'\)/);
  });

  it('is mounted behind CRM auth with its own limiter', () => {
    const routes = read('routes/lead.route.ts');
    const authAt = routes.indexOf('router.use(crmAuth())');
    const draftAt = routes.indexOf('router.post("/:id/ai-draft", staffAiDraftLimiter, generateLeadAiDraftHandler)');
    expect(authAt).toBeGreaterThan(-1);
    expect(draftAt).toBeGreaterThan(authAt);
  });
});
