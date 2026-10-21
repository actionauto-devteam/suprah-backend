import mongoose, { Document, Schema } from 'mongoose';
import { TrainingActorSchema, type TrainingActorRef } from './AiTrainingPolicy.model';

export const SCENARIO_CHANNELS = ['sms', 'webchat', 'email'] as const;
export type ScenarioChannel = (typeof SCENARIO_CHANNELS)[number];

export const SCENARIO_EXPECTED_HANDLING = ['ai_handles', 'ask_clarifying', 'escalate', 'safety_stop'] as const;
export type ScenarioExpectedHandling = (typeof SCENARIO_EXPECTED_HANDLING)[number];

export const SCENARIO_TURN_AUTHORS = ['customer', 'alex', 'staff'] as const;
export const SCENARIO_TYPES = ['behavior'] as const;
export const SCENARIO_SOURCES = ['manual'] as const;

export interface ScenarioContent {
  title: string;
  channel: ScenarioChannel;
  customerName?: string;
  vehicleInterest?: string;
  turns: Array<{ from: (typeof SCENARIO_TURN_AUTHORS)[number]; body: string }>;
  message: string;
  flags: { hasUpcomingAppointment: boolean; previouslyOptedOut: boolean };
  expectation: {
    handling: ScenarioExpectedHandling;
    mustAsk: string[];
    mustInclude: string[];
    mustAvoid: string[];
    notes?: string;
  };
  tags: string[];
  archived: boolean;
}

export interface IAiTrainingScenario extends Document, ScenarioContent {
  organizationId: string;
  scenarioType: (typeof SCENARIO_TYPES)[number];
  source: (typeof SCENARIO_SOURCES)[number];
  revision: number;
  adoptedRevisions: number[];
  archivedAt?: Date;
  createdBy: TrainingActorRef;
  lastEditedBy: TrainingActorRef;
  createdAt: Date;
  updatedAt: Date;
}

export const scenarioContentFields = () => ({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  channel: { type: String, enum: SCENARIO_CHANNELS, required: true },
  customerName: { type: String, trim: true, maxlength: 60 },
  vehicleInterest: { type: String, trim: true, maxlength: 120 },
  turns: {
    type: [{
      _id: false,
      from: { type: String, enum: SCENARIO_TURN_AUTHORS, required: true },
      body: { type: String, required: true, trim: true, maxlength: 500 },
    }],
    default: [],
  },
  message: { type: String, required: true, trim: true, maxlength: 500 },
  flags: {
    hasUpcomingAppointment: { type: Boolean, default: false },
    previouslyOptedOut: { type: Boolean, default: false },
  },
  expectation: {
    handling: { type: String, enum: SCENARIO_EXPECTED_HANDLING, required: true },
    mustAsk: { type: [{ type: String, trim: true, maxlength: 200 }], default: [] },
    mustInclude: { type: [{ type: String, trim: true, maxlength: 200 }], default: [] },
    mustAvoid: { type: [{ type: String, trim: true, maxlength: 200 }], default: [] },
    notes: { type: String, trim: true, maxlength: 300 },
  },
  tags: { type: [{ type: String, trim: true, maxlength: 40 }], default: [] },
  archived: { type: Boolean, default: false },
});

const AiTrainingScenarioSchema: Schema<IAiTrainingScenario> = new Schema(
  {
    organizationId: { type: String, required: true },
    ...scenarioContentFields(),
    scenarioType: { type: String, enum: SCENARIO_TYPES, default: 'behavior' },
    source: { type: String, enum: SCENARIO_SOURCES, default: 'manual' },
    revision: { type: Number, required: true, min: 1 },
    adoptedRevisions: { type: [Number], default: [] },
    archivedAt: { type: Date },
    createdBy: { type: TrainingActorSchema, required: true },
    lastEditedBy: { type: TrainingActorSchema, required: true },
  },
  { timestamps: true },
);

AiTrainingScenarioSchema.index({ organizationId: 1, archived: 1, updatedAt: -1 }, { name: 'ai_training_scenario_org_recent' });

const AiTrainingScenario = mongoose.model<IAiTrainingScenario>('AiTrainingScenario', AiTrainingScenarioSchema);

export default AiTrainingScenario;
