import mongoose from 'mongoose';
import { Conversation, CommunicationMessage } from '../src/models/communication.model';
import { handleSmsStatus } from '../src/services/communication.service';

describe('Real-DB proof: Telnyx delivery events only move an SMS status forward', () => {
  const orgId = new mongoose.Types.ObjectId();
  let conversationId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    jest.setTimeout(30000);
    const conversation = await Conversation.create({ orgId, customerPhone: '+13855550142' });
    conversationId = conversation._id as mongoose.Types.ObjectId;
  });

  afterAll(async () => {
    await CommunicationMessage.deleteMany({ orgId });
    await Conversation.deleteMany({ orgId });
  });

  async function makeMessage(status: string, providerMessageId: string) {
    return CommunicationMessage.create({
      orgId,
      conversationId,
      direction: 'outbound',
      body: 'Test text',
      from: '+13855035869',
      to: '+13855550142',
      status,
      providerMessageId,
    });
  }

  async function statusOf(providerMessageId: string) {
    const doc: any = await CommunicationMessage.findOne({ providerMessageId }).lean();
    return doc?.status;
  }

  it('moves queued -> sent -> delivered in order', async () => {
    await makeMessage('queued', 'rdb-forward-1');
    await handleSmsStatus({ id: 'rdb-forward-1', to: [{ status: 'sent' }] });
    expect(await statusOf('rdb-forward-1')).toBe('sent');
    await handleSmsStatus({ id: 'rdb-forward-1', to: [{ status: 'delivered' }] });
    expect(await statusOf('rdb-forward-1')).toBe('delivered');
  });

  it('ignores a late "sent" event after the message was delivered', async () => {
    await makeMessage('delivered', 'rdb-forward-2');
    await handleSmsStatus({ id: 'rdb-forward-2', to: [{ status: 'sent' }] });
    expect(await statusOf('rdb-forward-2')).toBe('delivered');
  });

  it('keeps a failed message failed when a late "sent" or "delivered" event arrives', async () => {
    await makeMessage('failed', 'rdb-forward-3');
    await handleSmsStatus({ id: 'rdb-forward-3', to: [{ status: 'sent' }] });
    await handleSmsStatus({ id: 'rdb-forward-3', to: [{ status: 'delivered' }] });
    expect(await statusOf('rdb-forward-3')).toBe('failed');
  });

  it('keeps a delivered message delivered when a late failure event arrives', async () => {
    await makeMessage('delivered', 'rdb-forward-4');
    await handleSmsStatus({ id: 'rdb-forward-4', to: [{ status: 'delivery_failed', errors: [{ code: '40300' }] }] });
    expect(await statusOf('rdb-forward-4')).toBe('delivered');
  });

  it('resolves a pending_reconciliation message once Telnyx confirms delivery', async () => {
    await makeMessage('pending_reconciliation', 'rdb-forward-5');
    await handleSmsStatus({ id: 'rdb-forward-5', to: [{ status: 'delivered' }] });
    const doc: any = await CommunicationMessage.findOne({ providerMessageId: 'rdb-forward-5' }).lean();
    expect(doc.status).toBe('delivered');
    expect(doc.deliveredAt).toBeInstanceOf(Date);
  });

  it('never changes an inbound message', async () => {
    const inbound = await CommunicationMessage.create({
      orgId,
      conversationId,
      direction: 'inbound',
      body: 'Customer text',
      from: '+13855550142',
      to: '+13855035869',
      status: 'received',
      providerMessageId: 'rdb-forward-6',
    });
    await handleSmsStatus({ id: 'rdb-forward-6', to: [{ status: 'delivered' }] });
    const doc: any = await CommunicationMessage.findById(inbound._id).lean();
    expect(doc.status).toBe('received');
  });
});
