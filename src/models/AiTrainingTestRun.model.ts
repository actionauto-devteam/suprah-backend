import mongoose, { Document, Schema } from 'mongoose';
import { makeAppendOnly } from '../utils/appendOnlySchema';
import { TrainingActorSchema, type TrainingActorRef } from './AiTrainingPolicy.model';
import { ScenarioContent, scenarioContentFields } from './AiTrainingScenario.model';

export const TEST_RUN_RETENTION_DAYS = 365;
export const TEST_RUN_MODES = ['rules_only', 'sample_reply'] as const;
export type TestRunMode = (typeof TEST_RUN_MODES)[number];
export const TEST_CHECK_STATUSES = ['pass', 'fail', 'warning', 'not_evaluated'] as const;
export type TestCheckStatus = (typeof TEST_CHECK_STATUSES)[number];
export const TEST_CHECK_METHODS = ['deterministic', 'keyword_rule', 'existing_safety_filter', 'approximate', 'local_mock_screening'] as const;
export type TestCheckMethod = (typeof TEST_CHECK_METHODS)[number];
export const TEST_RUN_VERDICTS = ['failed', 'needs_review', 'incomplete', 'checks_passed'] as const;
export type TestRunVerdict = (typeof TEST_RUN_VERDICTS)[number];

export interface TestCheck {
  id: string;
  group: 'safety' | 'handling' | 'rule' | 'reply';
  label: string;
  status: TestCheckStatus;
  method: TestCheckMethod;
  message: string;
  optional?: boolean;
}

export interface IAiTrainingTestRun extends Document {
  organizationId: string;
  policyId: mongoose.Types.ObjectId;
  policyVersion: number;
  policyStatusAtRun: string;
  policyTitle: string;
  policyAuthorId: string;
  policySpecHash: string;
  ruleFormat: string;
  scenarioId: mongoose.Types.ObjectId;
  scenarioRevision: number;
  scenarioSnapshot: ScenarioContent;
  channel: string;
  mode: TestRunMode;
  reply?: { source: 'written' | 'rule_example'; exampleIndex?: number; text: string };
  engineVersion: string;
  checks: TestCheck[];
  counts: { pass: number; fail: number; warning: number; notEvaluated: number };
  verdict: TestRunVerdict;
  includesApproximate: boolean;
  runBy: TrainingActorRef;
  createdAt: Date;
  expiresAt: Date;
}

const AiTrainingTestRunSchema: Schema<IAiTrainingTestRun> = new Schema(
  {
    organizationId: { type: String, required: true },
    policyId: { type: Schema.Types.ObjectId, ref: 'AiTrainingPolicy', required: true },
    policyVersion: { type: Number, required: true, min: 1 },
    policyStatusAtRun: { type: String, required: true },
    policyTitle: { type: String, required: true, maxlength: 120 },
    policyAuthorId: { type: String, required: true },
    policySpecHash: { type: String, required: true },
    ruleFormat: { type: String, required: true },
    scenarioId: { type: Schema.Types.ObjectId, ref: 'AiTrainingScenario', required: true },
    scenarioRevision: { type: Number, required: true, min: 1 },
    scenarioSnapshot: { type: new Schema(scenarioContentFields(), { _id: false }), required: true },
    channel: { type: String, required: true },
    mode: { type: String, enum: TEST_RUN_MODES, required: true },
    reply: {
      type: new Schema({
        source: { type: String, enum: ['written', 'rule_example'], required: true },
        exampleIndex: { type: Number },
        text: { type: String, required: true, maxlength: 1000 },
      }, { _id: false }),
    },
    engineVersion: { type: String, required: true },
    checks: {
      type: [{
        _id: false,
        id: { type: String, required: true },
        group: { type: String, enum: ['safety', 'handling', 'rule', 'reply'], required: true },
        label: { type: String, required: true },
        status: { type: String, enum: TEST_CHECK_STATUSES, required: true },
        method: { type: String, enum: TEST_CHECK_METHODS, required: true },
        message: { type: String, required: true },
        optional: { type: Boolean },
      }],
      default: [],
    },
    counts: {
      pass: { type: Number, required: true },
      fail: { type: Number, required: true },
      warning: { type: Number, required: true },
      notEvaluated: { type: Number, required: true },
    },
    verdict: { type: String, enum: TEST_RUN_VERDICTS, required: true },
    includesApproximate: { type: Boolean, required: true },
    runBy: { type: TrainingActorSchema, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

AiTrainingTestRunSchema.index({ organizationId: 1, policyId: 1, policyVersion: 1, createdAt: -1 }, { name: 'ai_training_run_org_policy' });
AiTrainingTestRunSchema.index({ organizationId: 1, scenarioId: 1, createdAt: -1 }, { name: 'ai_training_run_org_scenario' });
AiTrainingTestRunSchema.index({ organizationId: 1, createdAt: -1 }, { name: 'ai_training_run_org_recent' });
AiTrainingTestRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ai_training_run_retention' });
makeAppendOnly(AiTrainingTestRunSchema, 'AiTrainingTestRun');

const AiTrainingTestRun = mongoose.model<IAiTrainingTestRun>('AiTrainingTestRun', AiTrainingTestRunSchema);

export default AiTrainingTestRun;
