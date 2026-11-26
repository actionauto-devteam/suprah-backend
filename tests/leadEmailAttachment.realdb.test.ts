import mongoose from 'mongoose';
import Lead from '../src/models/lead.model';
import { attachmentParts, readLeadEmailAttachment } from '../src/services/leadEmailAttachment.service';

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const owner = new mongoose.Types.ObjectId();
const PDF = Buffer.from('%PDF-1.4 test file');

function gmailFor(threadId: string) {
  const messagesGet = jest.fn(async () => ({
    data: {
      threadId,
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('hello').toString('base64url') } },
          { filename: 'photo.jpg', mimeType: 'image/jpeg', body: { data: Buffer.from('JPEG').toString('base64url') } },
          { filename: 'Carfax.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att-1' } },
        ],
      },
    },
  }));
  const attachmentsGet = jest.fn(async () => ({ data: { data: PDF.toString('base64url') } }));
  return { client: { users: { messages: { get: messagesGet, attachments: { get: attachmentsGet } } } }, messagesGet, attachmentsGet };
}

describe('Real-DB: opening email attachments from a lead card (local MongoDB only)', () => {
  let leadId = '';
  let otherLeadId = '';

  beforeAll(async () => {
    const lead = await Lead.create({ organizationId: orgId, createdBy: owner, firstName: 'Ema', lastName: 'Test', email: 'ema@example.com', source: 'Email Inquiry', channel: 'email', status: 'Contacted', comments: '', threadId: 'thread-1', previousThreadIds: ['thread-0'] } as any);
    const other = await Lead.create({ organizationId: otherOrgId, createdBy: owner, firstName: 'Oz', lastName: 'Other', email: 'oz@example.com', source: 'Email Inquiry', channel: 'email', status: 'Contacted', comments: '', threadId: 'thread-1' } as any);
    leadId = String(lead._id);
    otherLeadId = String(other._id);
  });

  it('lists attachments in the same order the conversation shows them', () => {
    const names = attachmentParts({ parts: [{ filename: 'a.jpg' }, { parts: [{ filename: 'b.pdf' }] }, { mimeType: 'text/plain' }] } as any).map((part) => part.filename);
    expect(names).toEqual(['a.jpg', 'b.pdf']);
  });

  it('opens an attachment stored inline and one that needs a separate download', async () => {
    const { client, attachmentsGet } = gmailFor('thread-1');
    const photo = await readLeadEmailAttachment({ organizationId: String(orgId), leadId, gmailId: '18c2f0a1b2c3d4e5', index: 0, gmailClient: client });
    expect(photo).toEqual({ buffer: Buffer.from('JPEG'), name: 'photo.jpg', contentType: 'image/jpeg' });
    const pdf = await readLeadEmailAttachment({ organizationId: String(orgId), leadId, gmailId: '18c2f0a1b2c3d4e5', index: 1, gmailClient: client });
    expect(pdf?.buffer.equals(PDF)).toBe(true);
    expect(pdf?.name).toBe('Carfax.pdf');
    expect(attachmentsGet).toHaveBeenCalledWith({ userId: 'me', messageId: '18c2f0a1b2c3d4e5', id: 'att-1' });
  });

  it('opens attachments from an earlier email thread of the same lead', async () => {
    const { client } = gmailFor('thread-0');
    expect(await readLeadEmailAttachment({ organizationId: String(orgId), leadId, gmailId: '18c2f0a1b2c3d4e0', index: 0, gmailClient: client })).not.toBeNull();
  });

  it('refuses an email that is not part of this lead, another dealership, a bad id or a missing attachment', async () => {
    const foreign = gmailFor('someone-else');
    expect(await readLeadEmailAttachment({ organizationId: String(orgId), leadId, gmailId: '18c2f0a1b2c3d4e9', index: 0, gmailClient: foreign.client })).toBeNull();
    const { client, messagesGet } = gmailFor('thread-1');
    expect(await readLeadEmailAttachment({ organizationId: String(orgId), leadId: otherLeadId, gmailId: '18c2f0a1b2c3d4e5', index: 0, gmailClient: client })).toBeNull();
    expect(await readLeadEmailAttachment({ organizationId: String(orgId), leadId, gmailId: '../../x', index: 0, gmailClient: client })).toBeNull();
    expect(await readLeadEmailAttachment({ organizationId: String(orgId), leadId, gmailId: '18c2f0a1b2c3d4e5', index: 7, gmailClient: client })).toBeNull();
    expect(messagesGet).toHaveBeenCalledTimes(1);
  });
});
