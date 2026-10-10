const mockLeadFindOne = jest.fn();
const mockGroupFind = jest.fn();
const mockUserFind = jest.fn();
const mockCreateActivity = jest.fn();
const mockGetSocketIO = jest.fn();
const mockNotifyUsers = jest.fn();

jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: { findOne: mockLeadFindOne },
}));

jest.mock('../../src/models/CrmLeadGroup.model', () => ({
  __esModule: true,
  default: { find: mockGroupFind },
}));

jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { find: mockUserFind },
}));

jest.mock('../../src/services/activity.service', () => ({
  __esModule: true,
  default: { createActivity: mockCreateActivity },
}));

jest.mock('../../src/utils/socketEmitter', () => ({
  __esModule: true,
  getSocketIO: mockGetSocketIO,
}));

jest.mock('../../src/utils/safeNotification', () => ({
  __esModule: true,
  notifyUsers: mockNotifyUsers,
}));

import { addLeadNoteAndNotify, shouldSuppressHandoffNoteNotification } from '../../src/utils/leadNote';

function makeLead(overrides: Partial<{ notes: any[] }> = {}) {
  const lead: any = {
    _id: 'lead-1',
    firstName: 'Jordan',
    lastName: 'Smith',
    notes: overrides.notes || [],
    save: jest.fn().mockImplementation(async function (this: any) {
      return this;
    }),
  };
  lead.notes.push = Array.prototype.push.bind(lead.notes);
  return lead;
}

function selectLeanChain(result: any) {
  return { select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(result) }) };
}

describe('addLeadNoteAndNotify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateActivity.mockResolvedValue(undefined);
    mockGetSocketIO.mockReturnValue(null);
    mockNotifyUsers.mockResolvedValue(undefined);
    mockGroupFind.mockReturnValue(selectLeanChain([]));
    mockUserFind.mockReturnValue(selectLeanChain([]));
  });

  it('saves a plain note with no mentions and never notifies anyone', async () => {
    const lead = makeLead();
    mockLeadFindOne.mockResolvedValue(lead);

    const result = await addLeadNoteAndNotify({
      organizationId: 'org-1',
      leadId: 'lead-1',
      text: 'Called the customer, no answer.',
      authorType: 'user',
      createdBy: 'user-1',
      authorName: 'Erik Schofield',
    });

    expect(lead.notes.length).toBe(1);
    expect(lead.notes[0].text).toBe('Called the customer, no answer.');
    expect(lead.notes[0].authorType).toBe('user');
    expect(lead.save).toHaveBeenCalledTimes(1);
    expect(mockNotifyUsers).not.toHaveBeenCalled();
    expect(result.note.text).toBe('Called the customer, no answer.');
  });

  it('notifies exactly the individually mentioned user', async () => {
    const lead = makeLead();
    mockLeadFindOne.mockResolvedValue(lead);

    await addLeadNoteAndNotify({
      organizationId: 'org-1',
      leadId: 'lead-1',
      text: '@Keaton can you confirm the trade-in appraisal?',
      authorType: 'user',
      createdBy: 'user-1',
      authorName: 'Erik Schofield',
      mentionedUserIds: ['user-2'],
    });

    expect(mockNotifyUsers).toHaveBeenCalledTimes(1);
    expect(mockNotifyUsers).toHaveBeenCalledWith(
      ['user-2'],
      'org-1',
      'lead_note_mention',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ leadId: 'lead-1' }),
    );
  });

  it('expands a group mention to only its active members, deduped against an overlapping individual mention', async () => {
    const lead = makeLead();
    mockLeadFindOne.mockResolvedValue(lead);
    mockGroupFind.mockReturnValue(selectLeanChain([{ memberIds: ['user-2', 'user-3'] }]));
    mockUserFind.mockReturnValue(selectLeanChain([{ _id: 'user-2' }, { _id: 'user-3' }]));

    await addLeadNoteAndNotify({
      organizationId: 'org-1',
      leadId: 'lead-1',
      text: '@Online Team please follow up',
      authorType: 'ai',
      authorName: 'Alex',
      mentionedUserIds: ['user-2'],
      mentionedGroupIds: ['group-1'],
    });

    const [recipients] = mockNotifyUsers.mock.calls[0];
    expect(recipients.sort()).toEqual(['user-2', 'user-3']);
  });

  it('excludes the note author from their own mention notification', async () => {
    const lead = makeLead();
    mockLeadFindOne.mockResolvedValue(lead);

    await addLeadNoteAndNotify({
      organizationId: 'org-1',
      leadId: 'lead-1',
      text: 'Reminder to myself',
      authorType: 'user',
      createdBy: 'user-1',
      authorName: 'Erik Schofield',
      mentionedUserIds: ['user-1'],
    });

    expect(mockNotifyUsers).not.toHaveBeenCalled();
  });

  it('round-trips an old-shape note with no new fields without throwing', async () => {
    const oldNote = { text: 'Legacy note from before mentions existed', createdAt: new Date(), createdBy: 'user-9' };
    const lead = makeLead({ notes: [oldNote] });
    mockLeadFindOne.mockResolvedValue(lead);

    const result = await addLeadNoteAndNotify({
      organizationId: 'org-1',
      leadId: 'lead-1',
      text: 'A fresh note',
      authorType: 'user',
      createdBy: 'user-1',
      authorName: 'Erik Schofield',
    });

    expect(lead.notes[0]).toBe(oldNote);
    expect(result.note.text).toBe('A fresh note');
  });

  it('throws when the lead does not exist', async () => {
    mockLeadFindOne.mockResolvedValue(null);

    await expect(
      addLeadNoteAndNotify({
        organizationId: 'org-1',
        leadId: 'missing-lead',
        text: 'hello',
        authorType: 'user',
        createdBy: 'user-1',
        authorName: 'Erik Schofield',
      }),
    ).rejects.toThrow('Lead not found');
  });

  it('still creates the note but skips notifyUsers when suppressNotification is true', async () => {
    const lead = makeLead();
    mockLeadFindOne.mockResolvedValue(lead);

    const result = await addLeadNoteAndNotify({
      organizationId: 'org-1',
      leadId: 'lead-1',
      text: 'Customer needs a human to confirm trim availability.',
      authorType: 'ai',
      authorName: 'Alex',
      mentionedUserIds: ['user-2'],
      suppressNotification: true,
    });

    expect(lead.notes.length).toBe(1);
    expect(lead.notes[0].mentionedUserIds).toEqual(['user-2']);
    expect(lead.save).toHaveBeenCalledTimes(1);
    expect(mockNotifyUsers).not.toHaveBeenCalled();
    expect(result.note.mentionedUserIds).toEqual(['user-2']);
  });

  it('still notifies normally when suppressNotification is explicitly false', async () => {
    const lead = makeLead();
    mockLeadFindOne.mockResolvedValue(lead);

    await addLeadNoteAndNotify({
      organizationId: 'org-1',
      leadId: 'lead-1',
      text: 'Customer needs a human to confirm trim availability.',
      authorType: 'ai',
      authorName: 'Alex',
      mentionedUserIds: ['user-2'],
      suppressNotification: false,
    });

    expect(mockNotifyUsers).toHaveBeenCalledTimes(1);
  });

  it('omitting suppressNotification entirely behaves exactly like false (default-safe)', async () => {
    const lead = makeLead();
    mockLeadFindOne.mockResolvedValue(lead);

    await addLeadNoteAndNotify({
      organizationId: 'org-1',
      leadId: 'lead-1',
      text: 'Customer needs a human to confirm trim availability.',
      authorType: 'ai',
      authorName: 'Alex',
      mentionedUserIds: ['user-2'],
    });

    expect(mockNotifyUsers).toHaveBeenCalledTimes(1);
  });

  it('suppressNotification has no effect when there is nobody to notify (missing recipients)', async () => {
    const lead = makeLead();
    mockLeadFindOne.mockResolvedValue(lead);

    await addLeadNoteAndNotify({
      organizationId: 'org-1',
      leadId: 'lead-1',
      text: 'Needs human follow-up',
      authorType: 'ai',
      authorName: 'Alex',
      suppressNotification: true,
    });

    expect(mockNotifyUsers).not.toHaveBeenCalled();
  });
});

describe('shouldSuppressHandoffNoteNotification', () => {
  it('suppresses only when there is an assigned rep AND the task notification confirmed success', () => {
    expect(shouldSuppressHandoffNoteNotification('user-1', true)).toBe(true);
  });

  it('never suppresses when the task notification did not confirm success, even with an assigned rep', () => {
    expect(shouldSuppressHandoffNoteNotification('user-1', false)).toBe(false);
  });

  it('never suppresses when there is no assigned rep, regardless of task notification outcome (fallback group / org-admin case)', () => {
    expect(shouldSuppressHandoffNoteNotification(null, true)).toBe(false);
    expect(shouldSuppressHandoffNoteNotification(undefined, true)).toBe(false);
    expect(shouldSuppressHandoffNoteNotification(null, false)).toBe(false);
  });

  it('is a pure function that returns the same result across repeated calls (repeated handoff events)', () => {
    const results = Array.from({ length: 5 }, () => shouldSuppressHandoffNoteNotification('user-1', true));
    expect(results.every((r) => r === true)).toBe(true);
  });
});
