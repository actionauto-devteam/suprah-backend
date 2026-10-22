# Suprah Meet live captions

Any joined attendee, including an admitted external guest, clicks CC to request English (US) live captions immediately. No host approval or separate Start action is required. Each viewer independently shows or hides their caption panel; hiding the panel or leaving does not stop captions for other attendees. The shared transcription stream continues until the meeting ends.

Authenticated requests must match an active participant in the user's organization. Guest requests need a valid pass for the exact meeting and organization, plus an active guest participant entry. Waiting-room users and people who already left cannot start captions. A short database claim coordinates simultaneous CC requests; existing streams are reused, and failed starts can be retried.

Captions use Chime's meeting audio and transcript events. They do not depend on browser speech recognition, recording, or access to the viewer's microphone. Partial phrases update in place, speaker identities resolve against the roster, and recent captions expire from the local display. The application does not persist these live captions as a transcript or send caption text over its general chat channel.

This initial version supports English (US), as requested. It recognizes spoken English and does not translate other languages.

## AWS deployment requirements

- The API runtime identity needs `chime:StartMeetingTranscription` and `chime:StopMeetingTranscription`.
- The AWS account needs `AWSServiceRoleForAmazonChimeTranscription`, with trust for `transcription.chime.amazonaws.com`. An authorized administrator can prepare this role through IAM. The application does not provision IAM roles.
- Transcription uses region `auto` and Amazon Transcribe streaming. Confirm regional availability, quotas and billing before enabling it in the deployed environment.
- The API and frontend changes must both be deployed. Restart or refresh the installed PWA when the release is ready.

References: [AWS account configuration](https://docs.aws.amazon.com/chime-sdk/latest/dg/configure-transcribe.html), [start/stop transcription](https://docs.aws.amazon.com/chime-sdk/latest/dg/initiate-transcription.html), [supported settings and languages](https://docs.aws.amazon.com/chime-sdk/latest/APIReference/API_meeting-chime_EngineTranscribeSettings.html).

## Verification

Backend unit tests mock AWS and database operations. Frontend tests cover transcript revisions, speaker separation, bounded local buffers and rendered caption controls. These do not establish that the deployed AWS identity has the required permissions or that audio-to-text is operational.

Before release acceptance, use two signed-in devices and an admitted guest: a non-host clicks CC, each device speaks, viewers independently toggle CC, then repeat after reconnecting. Verify that concurrent CC clicks reuse one stream and hiding one viewer's captions does not interrupt anyone else. Check a phone in portrait/landscape and verify that captions, video and call controls remain usable. Test provider failures without losing the meeting's audio/video session.
