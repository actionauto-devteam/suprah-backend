const mockSendSms = jest.fn();
const mockFiles = new Map<string, Buffer>();

jest.mock('../src/services/telnyx.service', () => {
  const actual = jest.requireActual('../src/services/telnyx.service');
  return { ...actual, COMPANY_NUMBER: '+18015550901', sendSms: (...args: unknown[]) => mockSendSms(...args) };
});
jest.mock('../src/services/storage.service', () => {
  const { Readable } = require('stream');
  let count = 0;
  const api = {
    upload: jest.fn(async (file: any, folder: string) => {
      const key = `${folder}/f${++count}-${file.originalname}`;
      mockFiles.set(key, file.buffer);
      return key;
    }),
    getSignedUrl: jest.fn(async (key: string) => `https://files.example.com/${key}`),
    streamPrivateFile: jest.fn(async (key: string) => (mockFiles.has(key) ? { stream: Readable.from([mockFiles.get(key)]), contentType: 'application/octet-stream' } : null)),
  };
  return { __esModule: true, BucketType: { PUBLIC: 'public', PRIVATE: 'private', FTP: 'ftp' }, storageService: api, default: api };
});
jest.mock('../src/utils/socketEmitter', () => {
  const actual = jest.requireActual('../src/utils/socketEmitter');
  return { ...actual, getSocketIO: () => null, emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), streamLogToAdmins: jest.fn() };
});
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));
jest.mock('../src/utils/safeNotification', () => ({
  notifyOrgAdmins: jest.fn().mockResolvedValue(undefined),
  notifyUsers: jest.fn().mockResolvedValue(undefined),
  safeCreateNotification: jest.fn().mockResolvedValue(undefined),
}));

import mongoose from 'mongoose';
import { Readable } from 'stream';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import DealershipPhoneNumber from '../src/models/DealershipPhoneNumber.model';
import TextFileLink from '../src/models/TextFileLink.model';
import { CommunicationMessage, Conversation } from '../src/models/communication.model';
import { handleInboundSms, sendSmsFromUser } from '../src/services/communication.service';
import { openMessageMedia, openSharedFile } from '../src/services/textMedia.service';
import { setLeadIntakeMode, clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const COMPANY = '+18015550901';
const owner = new mongoose.Types.ObjectId();
const staff = { userId: String(new mongoose.Types.ObjectId()), name: 'Rita Rep' };
const saved = { org: process.env.COMM_ORG_ID };
let serial = 0;
const nextPhone = () => `+1801555${String(8100 + (++serial)).slice(-4)}`;
const file = (name: string, mimetype: string, size: number) => ({ buffer: Buffer.alloc(size, 7), originalname: name, mimetype, size });

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function openLead(phone: string) {
  return Lead.create({ organizationId: orgId, createdBy: owner, firstName: 'Tara', lastName: 'Test', phone, normalizedPhone: phone, source: 'SMS', channel: 'sms', status: 'Contacted', comments: '' } as any);
}

describe('Real-DB: photos and files by text (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    process.env.COMM_ORG_ID = ORG;
    await Promise.all([Lead.createIndexes(), LeadInquiry.init(), LeadIntakeControl.init(), Conversation.init(), DealershipPhoneNumber.init(), TextFileLink.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Photo Motors', slug: `p78-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'Other Dealer', slug: `p78-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertOne({ _id: owner, name: 'Olivia Owner', email: `p78-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true } as any);
    await DealershipPhoneNumber.collection.insertOne({ organizationId: orgId, number: COMPANY, label: 'Main test', kind: 'main', createdBy: owner, updatedBy: owner } as any);
    await setLeadIntakeMode({ organizationId: ORG, mode: 'active', reason: 'Phase 78 test', actor: staff });
  });

  beforeEach(() => {
    clearLeadIntakeModeCache();
    mockSendSms.mockReset();
    mockSendSms.mockImplementation(async (to: string) => ({ id: `sim-${++serial}`, to: [{ phone_number: to }] }));
  });

  afterAll(async () => {
    process.env.COMM_ORG_ID = saved.org;
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  it('sends a photo as a picture message and a PDF as a link the customer can open', async () => {
    const phone = nextPhone();
    const lead = await openLead(phone);
    const { message } = await sendSmsFromUser({
      orgId, user: staff, toPhone: phone, body: 'Here is the Carfax', leadId: lead._id, destinationPolicy: 'manual',
      files: [file('front.jpg', 'image/jpeg', 40_000), file('Carfax.pdf', 'application/pdf', 60_000)],
    });

    expect(mockSendSms).toHaveBeenCalledTimes(1);
    const [to, body, , mediaUrls] = mockSendSms.mock.calls[0];
    expect(to).toBe(phone);
    expect(mediaUrls).toHaveLength(1);
    expect(mediaUrls[0]).toMatch(/^https:\/\/files\.example\.com\/text-files\//);
    expect(body).toMatch(/^Here is the Carfax\n\nCarfax\.pdf: .*\/api\/public\/files\/[A-Za-z0-9_-]{16,}$/);

    const stored: any = await CommunicationMessage.findById(message._id).lean();
    expect(stored.media.map((item: any) => [item.name, item.kind, Boolean(item.linkToken)])).toEqual([['front.jpg', 'image', false], ['Carfax.pdf', 'file', true]]);

    const token = stored.media[1].linkToken;
    const shared = await openSharedFile(token);
    expect(shared?.name).toBe('Carfax.pdf');
    expect(shared?.contentType).toBe('application/pdf');
    expect((await readAll(shared!.stream)).length).toBe(60_000);
  });

  it('sends a big photo as a link instead of a picture message', async () => {
    const phone = nextPhone();
    const lead = await openLead(phone);
    await sendSmsFromUser({ orgId, user: staff, toPhone: phone, body: '', leadId: lead._id, destinationPolicy: 'manual', files: [file('big.jpg', 'image/jpeg', 1_500_000)] });
    const [, body, , mediaUrls] = mockSendSms.mock.calls[0];
    expect(mediaUrls).toBeUndefined();
    expect(body).toMatch(/^big\.jpg: .*\/api\/public\/files\//);
  });

  it('sends a photo with no words and saves a short label for the team', async () => {
    const phone = nextPhone();
    const lead = await openLead(phone);
    const { message } = await sendSmsFromUser({ orgId, user: staff, toPhone: phone, body: '', leadId: lead._id, destinationPolicy: 'manual', files: [file('side.png', 'image/png', 20_000)] });
    const [, body, , mediaUrls] = mockSendSms.mock.calls[0];
    expect(body).toBe('');
    expect(mediaUrls).toHaveLength(1);
    expect(message.body).toBe('Sent a photo');
  });

  it('still refuses a text with no words and no files', async () => {
    await expect(sendSmsFromUser({ orgId, user: staff, toPhone: nextPhone(), body: '  ', destinationPolicy: 'manual' })).rejects.toThrow('Message body is required');
  });

  it('opens a message photo only for the same dealership and stops sharing expired links', async () => {
    const phone = nextPhone();
    const lead = await openLead(phone);
    const { message } = await sendSmsFromUser({ orgId, user: staff, toPhone: phone, body: 'Photo', leadId: lead._id, destinationPolicy: 'manual', files: [file('a.jpg', 'image/jpeg', 1000), file('b.pdf', 'application/pdf', 1000)] });
    expect(await openMessageMedia(ORG, String(message._id), 0)).not.toBeNull();
    expect(await openMessageMedia(String(otherOrgId), String(message._id), 0)).toBeNull();
    expect(await openMessageMedia(ORG, String(message._id), 5)).toBeNull();

    const stored: any = await CommunicationMessage.findById(message._id).lean();
    const token = stored.media[1].linkToken;
    await TextFileLink.updateOne({ token }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await openSharedFile(token)).toBeNull();
    expect(await openSharedFile('not a token')).toBeNull();
  });

  it('keeps a picture-only text from a customer and shows it on their card', async () => {
    const phone = nextPhone();
    const lead = await openLead(phone);
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(Buffer.from('JPEGDATA'), { status: 200, headers: { 'content-type': 'image/jpeg' } }) as any);
    try {
      const message: any = await handleInboundSms({
        id: `in-${++serial}`,
        from: { phone_number: phone },
        to: [{ phone_number: COMPANY }],
        text: '',
        media: [{ url: 'https://media.example.com/one.jpg', content_type: 'image/jpeg' }, { url: 'https://media.example.com/two.jpg', content_type: 'image/jpeg' }],
      });
      expect(message).toBeTruthy();
      const stored: any = await CommunicationMessage.findById(message._id).lean();
      expect(stored.body).toBe('Sent 2 photos');
      expect(stored.media.map((item: any) => [item.name, item.kind])).toEqual([['photo-1.jpg', 'image'], ['photo-2.jpg', 'image']]);
      expect(String(stored.leadId)).toBe(String(lead._id));
      const opened = await openMessageMedia(ORG, String(message._id), 1);
      expect((await readAll(opened!.stream)).toString()).toBe('JPEGDATA');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('keeps the words and the photo when a customer sends both', async () => {
    const phone = nextPhone();
    await openLead(phone);
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(Buffer.from('PNGDATA'), { status: 200, headers: { 'content-type': 'image/png' } }) as any);
    try {
      const message: any = await handleInboundSms({
        id: `in-${++serial}`,
        from: { phone_number: phone },
        to: [{ phone_number: COMPANY }],
        text: 'Here is my trade in',
        media: [{ url: 'https://media.example.com/trade.png', content_type: 'image/png' }],
      });
      const stored: any = await CommunicationMessage.findById(message._id).lean();
      expect(stored.body).toBe('Here is my trade in');
      expect(stored.media).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('ignores picture links that are not https', async () => {
    const phone = nextPhone();
    await openLead(phone);
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      const message: any = await handleInboundSms({
        id: `in-${++serial}`,
        from: { phone_number: phone },
        to: [{ phone_number: COMPANY }],
        text: 'Look',
        media: [{ url: 'http://media.example.com/plain.jpg', content_type: 'image/jpeg' }],
      });
      const stored: any = await CommunicationMessage.findById(message._id).lean();
      expect(stored.media).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
