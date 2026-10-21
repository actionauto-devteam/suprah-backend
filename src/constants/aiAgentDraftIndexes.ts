export interface AiAgentDraftReportingIndex {
  name: string;
  key: Record<string, 1 | -1>;
}

export const AI_AGENT_DRAFT_COLLECTION = 'aiagentdrafts';

export const AI_AGENT_DRAFT_REPORTING_INDEXES: AiAgentDraftReportingIndex[] = [
  { name: 'ai_draft_org_status_recent', key: { organizationId: 1, status: 1, createdAt: -1 } },
  { name: 'ai_draft_org_channel_recent', key: { organizationId: 1, channel: 1, createdAt: -1 } },
];
