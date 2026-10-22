import type { RuleIssue, StructuredRule } from './aiTrainingRules.service';
import type { ImportIssue } from './aiTrainingImportParser';
import { avoidItemIssues, guardrailIssues, safetyIssues, type GuardrailClass } from './aiTrainingImportScreening';

function blocking(found: ImportIssue[]): RuleIssue[] {
  return found.filter((issue) => issue.severity === 'error').map(({ field, code, message }) => ({ field, code, message }));
}

function unique(issues: RuleIssue[]): RuleIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.field}:${issue.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function strictRuleIssues(rule: StructuredRule): RuleIssue[] {
  const scanned: Array<[string, string, GuardrailClass]> = [
    ['title', rule.title, 'question'],
    ['intent', rule.intent, 'question'],
    ...rule.triggers.map((text, index) => [`triggers.${index}`, text, 'question'] as [string, string, GuardrailClass]),
    ['instruction', rule.instruction, 'instruction'],
    ...rule.requiredQuestions.map((text, index) => [`requiredQuestions.${index}`, text, 'instruction'] as [string, string, GuardrailClass]),
    ...rule.mustInclude.map((text, index) => [`mustInclude.${index}`, text, 'instruction'] as [string, string, GuardrailClass]),
    ['escalation.when', rule.escalation.when, 'instruction'],
    ['escalation.handoffReason', rule.escalation.handoffReason, 'instruction'],
    ...rule.examples.flatMap((example, index) => [
      [`examples.${index}.customerMessage`, example.customerMessage, 'question'],
      [`examples.${index}.idealReply`, example.idealReply, 'reply'],
    ] as Array<[string, string, GuardrailClass]>),
  ];
  const issues: RuleIssue[] = [];
  for (const [field, text, cls] of scanned) {
    if (text) issues.push(...blocking(guardrailIssues(field, text, cls)));
  }
  for (const [field, text] of [['escalation.when', rule.escalation.when], ['escalation.handoffReason', rule.escalation.handoffReason]] as Array<[string, string]>) {
    if (text) issues.push(...blocking(safetyIssues(field, text)));
  }
  rule.mustAvoid.forEach((item, index) => issues.push(...blocking(avoidItemIssues(`mustAvoid.${index}`, item))));
  return unique(issues);
}

export function strictInstructionIssues(instruction: string): RuleIssue[] {
  const text = String(instruction || '');
  if (!text.trim()) return [];
  return unique([
    ...blocking(guardrailIssues('instruction', text, 'instruction')),
    ...blocking(safetyIssues('instruction', text)),
  ]);
}
