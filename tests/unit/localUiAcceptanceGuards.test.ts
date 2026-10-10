const sendMailMock = jest.fn().mockResolvedValue({ messageId: 'test-message-id' });

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: sendMailMock })),
}));

import * as telnyx from '../../src/services/telnyx.service';
import emailService from '../../src/services/email.service';

function resetLocalUiAcceptanceMode() {
  delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
}

describe('LOCAL_UI_ACCEPTANCE_MODE outbound guards', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, text: async () => '{"data":{"result":"ok"}}' } as Response);
    sendMailMock.mockClear();
    resetLocalUiAcceptanceMode();
  });

  afterEach(() => {
    fetchMock.mockRestore();
    resetLocalUiAcceptanceMode();
  });

  describe('Telnyx (telnyx.service.ts)', () => {
    it('blocks a tx()-routed call and never reaches fetch when the flag is set', async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      await expect(telnyx.answerCall('control-id')).rejects.toThrow(/LOCAL_UI_ACCEPTANCE_MODE/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('blocks createRtcLoginToken (which bypasses tx() with its own direct fetch) when the flag is set', async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      await expect(telnyx.createRtcLoginToken('cred-id')).rejects.toThrow(/LOCAL_UI_ACCEPTANCE_MODE/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('behaves exactly as before when the flag is absent', async () => {
      await telnyx.answerCall('control-id');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('behaves exactly as before for createRtcLoginToken when the flag is absent', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, text: async () => 'a-real-looking-jwt' } as Response);
      const token = await telnyx.createRtcLoginToken('cred-id');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(token).toBe('a-real-looking-jwt');
    });
  });

  describe('Email (email.service.ts)', () => {
    it('blocks sendEmail before any SMTP send when the flag is set', async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      await expect(
        emailService.sendEmail({ to: 'customer@example.com', subject: 'Hi', text: 'Hello' }),
      ).rejects.toThrow(/LOCAL_UI_ACCEPTANCE_MODE/);
      expect(sendMailMock).not.toHaveBeenCalled();
    });

    it('behaves exactly as before (sends via SMTP) when the flag is absent', async () => {
      await emailService.sendEmail({ to: 'customer@example.com', subject: 'Hi', text: 'Hello' });
      expect(sendMailMock).toHaveBeenCalledTimes(1);
    });
  });
});
