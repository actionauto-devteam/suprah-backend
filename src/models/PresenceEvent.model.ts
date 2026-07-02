import mongoose, { Document, Schema } from 'mongoose';

export type PresenceEventType =
  | 'online' | 'offline' | 'away' | 'busy' | 'idle' | 'do_not_disturb'
  | 'break_start' | 'break_end' | 'custom_status'
  | 'geofence_enter' | 'geofence_exit'
  | 'sos_triggered' | 'sos_resolved'
  | 'driving_session_start' | 'driving_session_end'
  | 'possible_incident'
  | 'location_sharing_started' | 'location_sharing_paused' | 'location_sharing_resumed' | 'location_sharing_stopped';

export interface IPresenceEvent extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId:         mongoose.Types.ObjectId;
  userName:       string;
  userAvatar?:    string;
  type:           PresenceEventType;
  description:    string;
  meta?:          Record<string, any>;
  createdAt:      Date;
}

const PresenceEventSchema = new Schema<IPresenceEvent>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
    userId:         { type: Schema.Types.ObjectId, required: true },
    userName:       { type: String, required: true },
    userAvatar:     { type: String },
    type:           { type: String, required: true },
    description:    { type: String, required: true },
    meta:           { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

PresenceEventSchema.index({ organizationId: 1, createdAt: -1 });
PresenceEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

export default mongoose.model<IPresenceEvent>('PresenceEvent', PresenceEventSchema);
