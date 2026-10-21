import mongoose, { Document, Schema } from 'mongoose';
import { makeAppendOnly } from '../utils/appendOnlySchema';
import { TrainingActorSchema, type TrainingActorRef } from './AiTrainingPolicy.model';
import { ScenarioContent, scenarioContentFields } from './AiTrainingScenario.model';

export const SCENARIO_REVISION_ACTIONS = ['created', 'edited', 'archived', 'restored'] as const;
export type ScenarioRevisionAction = (typeof SCENARIO_REVISION_ACTIONS)[number];

export interface IAiTrainingScenarioRevision extends Document {
  organizationId: string;
  scenarioId: mongoose.Types.ObjectId;
  revision: number;
  action: ScenarioRevisionAction;
  content: ScenarioContent;
  changeNote?: string;
  createdBy: TrainingActorRef;
  createdAt: Date;
}

const AiTrainingScenarioRevisionSchema: Schema<IAiTrainingScenarioRevision> = new Schema(
  {
    organizationId: { type: String, required: true },
    scenarioId: { type: Schema.Types.ObjectId, ref: 'AiTrainingScenario', required: true },
    revision: { type: Number, required: true, min: 1 },
    action: { type: String, enum: SCENARIO_REVISION_ACTIONS, required: true },
    content: { type: new Schema(scenarioContentFields(), { _id: false }), required: true },
    changeNote: { type: String, trim: true, maxlength: 300 },
    createdBy: { type: TrainingActorSchema, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

AiTrainingScenarioRevisionSchema.index({ scenarioId: 1, revision: 1 }, { unique: true, name: 'ai_training_scenario_revision_unique' });
AiTrainingScenarioRevisionSchema.index({ organizationId: 1, scenarioId: 1, revision: -1 }, { name: 'ai_training_scenario_revision_org' });
makeAppendOnly(AiTrainingScenarioRevisionSchema, 'AiTrainingScenarioRevision');

const AiTrainingScenarioRevision = mongoose.model<IAiTrainingScenarioRevision>('AiTrainingScenarioRevision', AiTrainingScenarioRevisionSchema);

export default AiTrainingScenarioRevision;
