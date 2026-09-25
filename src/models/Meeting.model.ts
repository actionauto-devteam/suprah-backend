import mongoose, { Document, Schema } from 'mongoose';

export interface IMeetingParticipant {
  crmUserId: mongoose.Types.ObjectId;
  fullName: string;
  avatar?: string;
  role: 'host' | 'participant';
  joinedAt: Date;
  leftAt?: Date;
}

export interface IMeetingSummary {
  overview: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: string[];
}

export interface IMeeting extends Document {
  organizationId: mongoose.Types.ObjectId;
  code: string;
  title: string;
  hostCrmUserId: mongoose.Types.ObjectId;
  status: 'scheduled' | 'live' | 'ended';
  scheduledAt?: Date;              // UTC instant of the MDT wall time chosen
  seriesId?: string;               // groups the sessions of a recurring meeting
  invitees: mongoose.Types.ObjectId[];
  inviteAll: boolean;
  inviteDepartments: string[];     // department keys tagged at creation (members
                                   // are resolved into `invitees` at create time)
  reminderSentAt?: Date;
  chimeMeetingId?: string;
  mediaRegion?: string;
  participants: IMeetingParticipant[];
  recording: {
    status: 'idle' | 'recording' | 'processing' | 'ready' | 'failed';
    capturePipelineId?: string;
    capturePipelineArn?: string;
    concatPipelineId?: string;
    startedAt?: Date;
    stoppedAt?: Date;
    s3Prefix?: string;
    videoKey?: string;
    error?: string;
  };
  ai: {
    status: 'idle' | 'transcribing' | 'summarizing' | 'ready' | 'failed';
    transcriptionJobName?: string;
    transcriptKey?: string;
    summary?: IMeetingSummary;
    generatedAt?: Date;
    error?: string;
  };
  startedAt?: Date;
  endedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MeetingSchema = new Schema<IMeeting>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    title: { type: String, required: true, trim: true, default: 'Instant meeting' },
    hostCrmUserId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
    status: { type: String, enum: ['scheduled', 'live', 'ended'], default: 'live', index: true },
    scheduledAt: { type: Date, default: null, index: true },
    seriesId: { type: String, default: null, index: true },
    invitees: [{ type: Schema.Types.ObjectId, ref: 'CrmUser' }],
    inviteAll: { type: Boolean, default: false },
    inviteDepartments: [{ type: String, trim: true }],
    reminderSentAt: { type: Date, default: null },
    chimeMeetingId: { type: String },
    mediaRegion: { type: String },
    participants: [
      {
        crmUserId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
        fullName: { type: String, required: true },
        avatar: { type: String, default: null },
        role: { type: String, enum: ['host', 'participant'], default: 'participant' },
        joinedAt: { type: Date, default: Date.now },
        leftAt: { type: Date },
      },
    ],
    recording: {
      status: { type: String, enum: ['idle', 'recording', 'processing', 'ready', 'failed'], default: 'idle' },
      capturePipelineId: { type: String },
      capturePipelineArn: { type: String },
      concatPipelineId: { type: String },
      startedAt: { type: Date },
      stoppedAt: { type: Date },
      s3Prefix: { type: String },
      videoKey: { type: String },
      error: { type: String },
    },
    ai: {
      status: { type: String, enum: ['idle', 'transcribing', 'summarizing', 'ready', 'failed'], default: 'idle' },
      transcriptionJobName: { type: String },
      transcriptKey: { type: String },
      summary: {
        overview: { type: String },
        keyPoints: [{ type: String }],
        decisions: [{ type: String }],
        actionItems: [{ type: String }],
      },
      generatedAt: { type: Date },
      error: { type: String },
    },
    startedAt: { type: Date },
    endedAt: { type: Date },
  },
  { timestamps: true }
);

MeetingSchema.index({ organizationId: 1, code: 1 }, { unique: true });
MeetingSchema.index({ organizationId: 1, status: 1, scheduledAt: 1 });

const Meeting = mongoose.model<IMeeting>('SuprahMeeting', MeetingSchema);
export default Meeting;