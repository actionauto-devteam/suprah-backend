import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
} from '@aws-sdk/client-transcribe';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { MEET_BUCKET, readS3Json } from './suprahMeetAws.service';
import type { IMeeting, IMeetingSummary } from '../models/Meeting.model';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const transcribeClient = new TranscribeClient({ region: AWS_REGION });

/**
 * Summarization provider:
 *  - "bedrock" (default): AWS Bedrock Converse with MEET_BEDROCK_MODEL_ID —
 *    keeps everything inside your AWS account/IAM.
 *  - "anthropic": direct Anthropic API with ANTHROPIC_API_KEY, if you'd
 *    rather not enable Bedrock model access.
 */
const AI_PROVIDER = (process.env.MEET_AI_PROVIDER || 'bedrock').toLowerCase();
const BEDROCK_MODEL_ID =
  process.env.MEET_BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const ANTHROPIC_MODEL = process.env.MEET_ANTHROPIC_MODEL || 'claude-sonnet-5';

// ── Transcription ───────────────────────────────────────────────────────────

export async function startTranscription(meeting: IMeeting, videoKey: string) {
  const jobName = `suprah-meet-${meeting._id}-${Date.now()}`;
  const transcriptKey = `meetings/${meeting._id}/transcripts/${jobName}.json`;

  await transcribeClient.send(
    new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      Media: { MediaFileUri: `s3://${MEET_BUCKET}/${videoKey}` },
      MediaFormat: 'mp4',
      IdentifyLanguage: true,
      LanguageOptions: ['en-US', 'tl-PH', 'es-US'],
      OutputBucketName: MEET_BUCKET,
      OutputKey: transcriptKey,
      Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: 10 },
    })
  );

  return { jobName, transcriptKey };
}

export async function getTranscriptionStatus(
  jobName: string
): Promise<'IN_PROGRESS' | 'COMPLETED' | 'FAILED'> {
  const res = await transcribeClient.send(
    new GetTranscriptionJobCommand({ TranscriptionJobName: jobName })
  );
  const status = res.TranscriptionJob?.TranscriptionJobStatus;
  if (status === 'COMPLETED') return 'COMPLETED';
  if (status === 'FAILED') return 'FAILED';
  return 'IN_PROGRESS';
}

/** Amazon Transcribe output → plain transcript text (speaker-labelled). */
export async function readTranscriptText(transcriptKey: string): Promise<string> {
  const data = await readS3Json<any>(transcriptKey);
  const transcripts: string[] = data?.results?.transcripts?.map((t: any) => t.transcript) ?? [];
  return transcripts.join('\n').trim();
}

// ── Summarization ───────────────────────────────────────────────────────────

function buildPrompt(meeting: IMeeting, transcript: string): string {
  const attendees = meeting.participants.map((p) => p.fullName).join(', ');
  return [
    'You are the meeting assistant for Suprah AI, a CRM platform for auto dealerships.',
    `Summarize the following meeting transcript. Meeting title: "${meeting.title}". Attendees: ${attendees || 'unknown'}.`,
    '',
    'Respond with ONLY a JSON object — no markdown fences, no preamble — in exactly this shape:',
    '{"overview": "2-4 sentence summary", "keyPoints": ["..."], "decisions": ["..."], "actionItems": ["Owner if identifiable: task"]}',
    '',
    'Rules: base everything strictly on the transcript; use empty arrays when a category has nothing; keep each item to one sentence.',
    '',
    'TRANSCRIPT:',
    transcript.slice(0, 150_000),
  ].join('\n');
}

function parseSummary(raw: string): IMeetingSummary {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  return {
    overview: String(parsed.overview ?? ''),
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map(String) : [],
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String) : [],
    actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.map(String) : [],
  };
}

async function summarizeWithBedrock(prompt: string): Promise<string> {
  const client = new BedrockRuntimeClient({ region: AWS_REGION });
  const res = await client.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 2000, temperature: 0.2 },
    })
  );
  const blocks = res.output?.message?.content ?? [];
  return blocks.map((b) => ('text' in b ? b.text : '')).join('');
}

async function summarizeWithAnthropic(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return (data.content ?? []).map((b: any) => b.text ?? '').join('');
}

export async function generateSummary(
  meeting: IMeeting,
  transcript: string
): Promise<IMeetingSummary> {
  const prompt = buildPrompt(meeting, transcript);
  const raw =
    AI_PROVIDER === 'anthropic'
      ? await summarizeWithAnthropic(prompt)
      : await summarizeWithBedrock(prompt);
  return parseSummary(raw);
}
