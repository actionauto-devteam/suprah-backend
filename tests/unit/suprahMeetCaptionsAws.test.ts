import { ChimeSDKMeetingsClient, StartMeetingTranscriptionCommand, StopMeetingTranscriptionCommand } from '@aws-sdk/client-chime-sdk-meetings';
import { startMeetingCaptions, stopMeetingCaptions } from '../../src/services/suprahMeetAws.service';

afterEach(() => jest.restoreAllMocks());

it('starts Chime live transcription with stable partial results and automatic region selection', async () => {
  const send = jest.spyOn(ChimeSDKMeetingsClient.prototype, 'send').mockResolvedValue({} as never);
  await startMeetingCaptions('chime-1', 'en-US');
  expect(send).toHaveBeenCalledTimes(1);
  const command = send.mock.calls[0][0] as StartMeetingTranscriptionCommand;
  expect(command).toBeInstanceOf(StartMeetingTranscriptionCommand);
  expect(command.input).toEqual({ MeetingId: 'chime-1', TranscriptionConfiguration: {
    EngineTranscribeSettings: {
      LanguageCode: 'en-US', Region: 'auto', EnablePartialResultsStabilization: true, PartialResultsStability: 'medium',
    },
  } });
});

it('stops only transcription without deleting the meeting or its recording', async () => {
  const send = jest.spyOn(ChimeSDKMeetingsClient.prototype, 'send').mockResolvedValue({} as never);
  await stopMeetingCaptions('chime-1');
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBeInstanceOf(StopMeetingTranscriptionCommand);
  expect((send.mock.calls[0][0] as StopMeetingTranscriptionCommand).input).toEqual({ MeetingId: 'chime-1' });
});
