import {
  ChimeSDKMeetingsClient, CreateMeetingCommand, CreateAttendeeCommand,
  GetMeetingCommand, DeleteMeetingCommand, NotFoundException,
} from '@aws-sdk/client-chime-sdk-meetings';
import {
  ChimeSDKMediaPipelinesClient, CreateMediaCapturePipelineCommand,
  CreateMediaConcatenationPipelineCommand, DeleteMediaCapturePipelineCommand,
} from '@aws-sdk/client-chime-sdk-media-pipelines';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

const CONTROL_REGION = process.env.MEET_CONTROL_REGION || 'us-east-1';
// IMPORTANT: media pipelines run in the meeting's media region, and the S3
// bucket must be in that same region. Set MEET_MEDIA_REGION=us-east-1 to
// match your suprah-meet-recordings-412102711383 bucket.
const MEDIA_REGION = process.env.MEET_MEDIA_REGION || 'us-east-1';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

export const MEET_BUCKET = process.env.MEET_RECORDINGS_BUCKET || '';
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || '';

const meetingsClient = new ChimeSDKMeetingsClient({ region: CONTROL_REGION });
const pipelinesClient = new ChimeSDKMediaPipelinesClient({ region: MEDIA_REGION });
export const s3Client = new S3Client({ region: AWS_REGION });

function assertConfigured() {
  if (!MEET_BUCKET) throw new Error('MEET_RECORDINGS_BUCKET is not set');
  if (!AWS_ACCOUNT_ID) throw new Error('AWS_ACCOUNT_ID is not set');
}

export async function createChimeMeeting(externalMeetingId: string) {
  const res = await meetingsClient.send(new CreateMeetingCommand({
    ClientRequestToken: randomUUID(),
    MediaRegion: MEDIA_REGION,
    ExternalMeetingId: externalMeetingId.slice(0, 64),
  }));
  return res.Meeting!;
}

export async function getChimeMeeting(meetingId: string) {
  try {
    const res = await meetingsClient.send(new GetMeetingCommand({ MeetingId: meetingId }));
    return res.Meeting ?? null;
  } catch (err) {
    if (err instanceof NotFoundException) return null;
    throw err;
  }
}

export async function createChimeAttendee(meetingId: string, externalUserId: string) {
  const res = await meetingsClient.send(new CreateAttendeeCommand({
    MeetingId: meetingId,
    ExternalUserId: externalUserId.slice(0, 64),
  }));
  return res.Attendee!;
}

export async function deleteChimeMeeting(meetingId: string) {
  try {
    await meetingsClient.send(new DeleteMeetingCommand({ MeetingId: meetingId }));
  } catch (err) {
    if (!(err instanceof NotFoundException)) throw err;
  }
}

export async function startRecordingPipelines(chimeMeetingId: string, s3Prefix: string) {
  assertConfigured();

  // FIXED: correct ARN format — arn:aws:chime::<account>:meeting:<id>
  // (no region segment, colon separators). The previous region/slash form
  // was rejected by AWS and surfaced as the 500 on /recording/start.
  const sourceArn = `arn:aws:chime::${AWS_ACCOUNT_ID}:meeting:${chimeMeetingId}`;

  const capture = await pipelinesClient.send(new CreateMediaCapturePipelineCommand({
    SourceType: 'ChimeSdkMeeting',
    SourceArn: sourceArn,
    SinkType: 'S3Bucket',
    SinkArn: `arn:aws:s3:::${MEET_BUCKET}/${s3Prefix}/capture`,
    ChimeSdkMeetingConfiguration: {
      ArtifactsConfiguration: {
        Audio: { MuxType: 'AudioWithCompositedVideo' },
        Video: { State: 'Disabled', MuxType: 'VideoOnly' },
        Content: { State: 'Disabled', MuxType: 'ContentOnly' },
        CompositedVideo: {
          Layout: 'GridView',
          Resolution: 'FHD',
          GridViewConfiguration: { ContentShareLayout: 'PresenterOnly' },
        },
      },
    },
  }));

  const pipeline = capture.MediaCapturePipeline!;

  const concat = await pipelinesClient.send(new CreateMediaConcatenationPipelineCommand({
    Sources: [{
      Type: 'MediaCapturePipeline',
      MediaCapturePipelineSourceConfiguration: {
        MediaPipelineArn: pipeline.MediaPipelineArn!,
        ChimeSdkMeetingConfiguration: {
          ArtifactsConfiguration: {
            Audio: { State: 'Enabled' },
            Video: { State: 'Disabled' },
            Content: { State: 'Disabled' },
            DataChannel: { State: 'Disabled' },
            TranscriptionMessages: { State: 'Disabled' },
            MeetingEvents: { State: 'Disabled' },
            CompositedVideo: { State: 'Enabled' },
          },
        },
      },
    }],
    Sinks: [{
      Type: 'S3Bucket',
      S3BucketSinkConfiguration: { Destination: `arn:aws:s3:::${MEET_BUCKET}/${s3Prefix}/concat` },
    }],
  }));

  return {
    capturePipelineId: pipeline.MediaPipelineId!,
    capturePipelineArn: pipeline.MediaPipelineArn!,
    concatPipelineId: concat.MediaConcatenationPipeline?.MediaPipelineId,
  };
}

export async function stopRecordingPipelines(capturePipelineId: string) {
  await pipelinesClient.send(new DeleteMediaCapturePipelineCommand({ MediaPipelineId: capturePipelineId }));
}

export async function findConcatenatedVideoKey(s3Prefix: string): Promise<string | null> {
  assertConfigured();
  const res = await s3Client.send(new ListObjectsV2Command({ Bucket: MEET_BUCKET, Prefix: `${s3Prefix}/concat/` }));
  const mp4s = (res.Contents ?? []).filter((o) => o.Key?.endsWith('.mp4'));
  if (mp4s.length === 0) return null;
  mp4s.sort((a, b) => (b.Size ?? 0) - (a.Size ?? 0));
  return mp4s[0].Key ?? null;
}

export async function presignGet(key: string, expiresSeconds = 3600): Promise<string> {
  return getSignedUrl(s3Client, new GetObjectCommand({ Bucket: MEET_BUCKET, Key: key }), { expiresIn: expiresSeconds });
}

export async function readS3Json<T = any>(key: string): Promise<T> {
  const res = await s3Client.send(new GetObjectCommand({ Bucket: MEET_BUCKET, Key: key }));
  const body = await res.Body!.transformToString();
  return JSON.parse(body) as T;
}