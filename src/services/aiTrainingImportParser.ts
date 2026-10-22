import crypto from 'crypto';
import { parse } from 'csv-parse/sync';
import { ApiError } from '../utils/ApiError';
import { IMPORT_FORMATS, type ImportFormat } from '../models/AiTrainingImportBatch.model';
import { IMPORT_ITEM_TYPES } from '../models/AiTrainingImportItem.model';

export const IMPORT_LIMITS = {
  rows: 200,
  contentBytes: 256 * 1024,
  fileName: 120,
  jsonDepth: 5,
  manualItems: 1,
  cellChars: 4000,
  businessContacts: 10,
  locationMappings: 100,
  nameAcknowledgements: 200,
} as const;

export const IMPORT_JSON_VERSION = 'suprah-import-v1';

export type ImportSeverity = 'error' | 'warning' | 'info';

export interface ImportIssue {
  field: string;
  code: string;
  severity: ImportSeverity;
  message: string;
}

export interface CanonicalValues {
  type: string;
  title: string;
  location: string;
  channels: string[];
  triggerOrQuestion: string;
  answerOrInstruction: string;
  handling: string;
  escalationWhen: string;
  handoffReason: string;
  requiredQuestions: string[];
  mustInclude: string[];
  mustAvoid: string[];
  exampleCustomer: string;
  exampleReply: string;
  topic: string;
  sourceRef: string;
  sourceStatus: string;
  notes: string;
}

export type CanonicalKey = keyof CanonicalValues;

export interface CanonicalRow {
  rowNumber: number;
  values: CanonicalValues;
  issues: ImportIssue[];
  unsupportedType: boolean;
}

export interface ParsedImportSource {
  format: ImportFormat;
  fileName?: string;
  contentSha256: string;
  contentBytes: number;
  rows: CanonicalRow[];
  batchIssues: ImportIssue[];
}

interface ColumnSpec {
  column: string;
  key: CanonicalKey;
  list: boolean;
  max: number;
  maxItems?: number;
  description: string;
}

export const IMPORT_COLUMNS: ColumnSpec[] = [
  { column: 'type', key: 'type', list: false, max: 30, description: 'rule, escalation, tone, faq, business_info, template, automation or example' },
  { column: 'title', key: 'title', list: false, max: 120, description: 'Short name reviewers will see' },
  { column: 'location', key: 'location', list: false, max: 80, description: 'The Podium location label. Leave empty for all locations' },
  { column: 'channels', key: 'channels', list: true, max: 20, maxItems: 3, description: 'sms | webchat | email, separated by |' },
  { column: 'trigger_or_question', key: 'triggerOrQuestion', list: false, max: 300, description: 'What the customer says or asks. For rules, separate several triggers with |' },
  { column: 'answer_or_instruction', key: 'answerOrInstruction', list: false, max: 1000, description: 'How Alex should respond, or the FAQ answer' },
  { column: 'handling', key: 'handling', list: false, max: 30, description: 'ai_handles, ask_clarifying or escalate. Leave empty to decide during review' },
  { column: 'escalation_when', key: 'escalationWhen', list: false, max: 300, description: 'When Alex should hand off to a person' },
  { column: 'handoff_reason', key: 'handoffReason', list: false, max: 200, description: 'Reason staff see on handoff' },
  { column: 'required_questions', key: 'requiredQuestions', list: true, max: 200, maxItems: 5, description: 'Follow-up questions, separated by |' },
  { column: 'must_include', key: 'mustInclude', list: true, max: 200, maxItems: 8, description: 'Always include, separated by |' },
  { column: 'must_avoid', key: 'mustAvoid', list: true, max: 200, maxItems: 8, description: 'Never include, separated by |' },
  { column: 'example_customer', key: 'exampleCustomer', list: false, max: 500, description: 'A made-up customer message' },
  { column: 'example_reply', key: 'exampleReply', list: false, max: 600, description: 'The ideal reply to that message' },
  { column: 'topic', key: 'topic', list: false, max: 40, description: 'For faq and business_info: hours, address_directions, contact, departments, test_drives, appointments, documents_required, trade_in_process, financing_process, delivery_shipping, service, warranty or general' },
  { column: 'source_ref', key: 'sourceRef', list: false, max: 120, description: 'Podium page, section or ID' },
  { column: 'source_status', key: 'sourceStatus', list: false, max: 20, description: 'On or Off in Podium. Kept as a note only; it never turns anything on in Suprah' },
  { column: 'notes', key: 'notes', list: false, max: 300, description: 'Shown to reviewers only, never copied into training' },
];

const COLUMN_BY_NAME = new Map(IMPORT_COLUMNS.map((spec) => [spec.column, spec]));

const HEADER_ALIASES: Record<string, string> = {
  question: 'trigger_or_question',
  trigger: 'trigger_or_question',
  triggers: 'trigger_or_question',
  answer: 'answer_or_instruction',
  instruction: 'answer_or_instruction',
  response: 'answer_or_instruction',
  podium_ref: 'source_ref',
  reference: 'source_ref',
  ref: 'source_ref',
  note: 'notes',
  channel: 'channels',
  status: 'source_status',
  podium_status: 'source_status',
  enabled: 'source_status',
};

const PASTE_KEYS: Record<string, string> = {
  q: 'trigger_or_question',
  question: 'trigger_or_question',
  trigger: 'trigger_or_question',
  a: 'answer_or_instruction',
  answer: 'answer_or_instruction',
  instruction: 'answer_or_instruction',
  title: 'title',
  type: 'type',
  location: 'location',
  topic: 'topic',
  channels: 'channels',
  channel: 'channels',
  handling: 'handling',
  ref: 'source_ref',
  source: 'source_ref',
  source_ref: 'source_ref',
  podium_ref: 'source_ref',
  notes: 'notes',
  status: 'source_status',
  podium_status: 'source_status',
  source_status: 'source_status',
  escalation_when: 'escalation_when',
  handoff_reason: 'handoff_reason',
  required_questions: 'required_questions',
  must_include: 'must_include',
  must_avoid: 'must_avoid',
  example_customer: 'example_customer',
  customer: 'example_customer',
  example_reply: 'example_reply',
  reply: 'example_reply',
};

const TYPE_ALIASES: Record<string, string> = {
  business_information: 'business_info',
  businessinfo: 'business_info',
  info: 'business_info',
  canned_reply: 'template',
  saved_reply: 'template',
  workflow: 'automation',
  escalation_rule: 'escalation',
  tone_rule: 'tone',
  behavior: 'rule',
  scenario: 'rule',
};

const CHANNEL_ALIASES: Record<string, string> = {
  sms: 'sms',
  text: 'sms',
  texting: 'sms',
  webchat: 'webchat',
  web_chat: 'webchat',
  chat: 'webchat',
  website_chat: 'webchat',
  email: 'email',
  'e-mail': 'email',
};

const HANDLING_ALIASES: Record<string, string> = {
  ai_handles: 'ai_handles',
  answer: 'ai_handles',
  alex_answers: 'ai_handles',
  ask_clarifying: 'ask_clarifying',
  ask: 'ask_clarifying',
  clarify: 'ask_clarifying',
  escalate: 'escalate',
  handoff: 'escalate',
  hand_off: 'escalate',
};

const SOURCE_STATUS_ALIASES: Record<string, string> = {
  on: 'on', enabled: 'on', active: 'on', yes: 'on', true: 'on',
  off: 'off', disabled: 'off', inactive: 'off', no: 'off', false: 'off',
};

const BLOCK_START_KEYS = new Set(['type', 'title', 'trigger_or_question', 'location', 'source_status', 'topic', 'channels', 'handling', 'source_ref']);
const PASTE_SEPARATOR = /^\s*-{3,}\s*$/;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const FORMULA_START = /^(?:[=+@\t\r]|-[^\s\-])/;

export function normalizeHeader(value: unknown): string {
  const header = String(value ?? '').replace(/^﻿/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return HEADER_ALIASES[header] || header;
}

function token(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function emptyValues(): CanonicalValues {
  return {
    type: '', title: '', location: '', channels: [], triggerOrQuestion: '', answerOrInstruction: '', handling: '',
    escalationWhen: '', handoffReason: '', requiredQuestions: [], mustInclude: [], mustAvoid: [], exampleCustomer: '',
    exampleReply: '', topic: '', sourceRef: '', sourceStatus: '', notes: '',
  };
}

function cleanString(value: string): string {
  return value.replace(CONTROL_CHARS, '').replace(/\r\n?/g, '\n').trim();
}

function splitList(value: string): string[] {
  return value.split('|').map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function uniqueItems(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function setField(row: CanonicalRow, spec: ColumnSpec, raw: unknown): void {
  const issues = row.issues;
  if (raw === undefined || raw === null) return;
  if (spec.list && Array.isArray(raw)) {
    const items: string[] = [];
    raw.forEach((item, index) => {
      if (typeof item !== 'string') {
        issues.push({ field: `${spec.column}.${index}`, code: 'invalid_type', severity: 'error', message: `Each item in ${spec.column} must be text.` });
        return;
      }
      items.push(...splitList(cleanString(item)));
    });
    assignList(row, spec, items);
    return;
  }
  if (typeof raw !== 'string') {
    issues.push({ field: spec.column, code: 'invalid_type', severity: 'error', message: `${spec.column} must be text.` });
    return;
  }
  if (raw.length > IMPORT_LIMITS.cellChars) {
    issues.push({ field: spec.column, code: 'too_long', severity: 'error', message: `${spec.column} is far too long.` });
  }
  const value = cleanString(raw.slice(0, IMPORT_LIMITS.cellChars));
  if (!value) return;
  if (FORMULA_START.test(value)) {
    issues.push({ field: spec.column, code: 'formula_like', severity: 'warning', message: `${spec.column} starts like a spreadsheet formula. It is kept as plain text.` });
  }
  if (spec.list) {
    assignList(row, spec, splitList(value));
    return;
  }
  if (value.length > spec.max) {
    issues.push({ field: spec.column, code: 'too_long', severity: 'error', message: `${spec.column} can be at most ${spec.max} characters.` });
  }
  (row.values as any)[spec.key] = value.slice(0, spec.max);
}

function assignList(row: CanonicalRow, spec: ColumnSpec, rawItems: string[]): void {
  const items = uniqueItems(rawItems);
  items.forEach((item, index) => {
    if (item.length > spec.max) {
      row.issues.push({ field: `${spec.column}.${index}`, code: 'too_long', severity: 'error', message: `Each item in ${spec.column} can be at most ${spec.max} characters.` });
    }
  });
  if (spec.maxItems && items.length > spec.maxItems) {
    row.issues.push({ field: spec.column, code: 'too_many', severity: 'error', message: `${spec.column} can have at most ${spec.maxItems} items.` });
  }
  (row.values as any)[spec.key] = items.slice(0, spec.maxItems || items.length).map((item) => item.slice(0, spec.max));
}

function finishRow(row: CanonicalRow): CanonicalRow {
  const values = row.values;
  const typeToken = token(values.type);
  const type = TYPE_ALIASES[typeToken] || typeToken;
  if (!type) {
    row.issues.push({ field: 'type', code: 'required', severity: 'error', message: 'Every row needs a type.' });
  } else if ((IMPORT_ITEM_TYPES as readonly string[]).includes(type)) {
    values.type = type;
  } else {
    values.type = type.slice(0, 30);
    row.unsupportedType = true;
  }

  const channels: string[] = [];
  for (const channel of values.channels) {
    const mapped = CHANNEL_ALIASES[token(channel)];
    if (!mapped) {
      row.issues.push({ field: 'channels', code: 'invalid_value', severity: 'error', message: 'Channels can only be sms, webchat or email.' });
    } else if (!channels.includes(mapped)) {
      channels.push(mapped);
    }
  }
  values.channels = ['sms', 'webchat', 'email'].filter((channel) => channels.includes(channel));

  if (values.handling) {
    const mapped = HANDLING_ALIASES[token(values.handling)];
    if (!mapped) {
      row.issues.push({ field: 'handling', code: 'invalid_value', severity: 'error', message: 'Handling must be ai_handles, ask_clarifying or escalate.' });
    } else {
      values.handling = mapped;
    }
  }
  values.topic = values.topic ? token(values.topic) : '';
  values.location = values.location.replace(/\s+/g, ' ');
  values.sourceRef = values.sourceRef.replace(/\s+/g, ' ');
  if (values.sourceStatus) {
    const status = SOURCE_STATUS_ALIASES[token(values.sourceStatus)];
    if (!status) {
      row.issues.push({ field: 'source_status', code: 'invalid_value', severity: 'error', message: 'Podium status must be On or Off.' });
      values.sourceStatus = '';
    } else {
      values.sourceStatus = status;
    }
  }

  if (!values.title && !values.triggerOrQuestion) {
    row.issues.push({ field: 'title', code: 'required', severity: 'error', message: 'Add a title or a trigger/question.' });
  }
  if (!values.answerOrInstruction && !['example', 'automation'].includes(values.type) && !row.unsupportedType) {
    row.issues.push({ field: 'answer_or_instruction', code: 'required', severity: 'error', message: 'Add the answer or instruction.' });
  }
  return row;
}

function newRow(rowNumber: number): CanonicalRow {
  return { rowNumber, values: emptyValues(), issues: [], unsupportedType: false };
}

function reject(message: string, code: string): never {
  throw new ApiError(400, message, [{ field: 'source', code, severity: 'error', message }]);
}

function cleanFileName(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') reject('The file name must be text.', 'invalid_file_name');
  const base = raw.replace(CONTROL_CHARS, '').split(/[\\/]/).pop() || '';
  const name = base.replace(/\s+/g, ' ').trim();
  if (!name) return undefined;
  if (name.length > IMPORT_LIMITS.fileName) reject(`File names can be at most ${IMPORT_LIMITS.fileName} characters.`, 'invalid_file_name');
  return name;
}

function checkTextContent(content: unknown): string {
  if (typeof content !== 'string') reject('Add the file content or pasted text.', 'missing_content');
  if (!content.trim()) reject('The import is empty.', 'empty_content');
  if (Buffer.byteLength(content, 'utf8') > IMPORT_LIMITS.contentBytes) {
    reject(`Imports can be at most ${Math.round(IMPORT_LIMITS.contentBytes / 1024)} KB. Split the file into smaller batches.`, 'too_large');
  }
  if (content.includes('�')) reject("The file isn't valid UTF-8 text. Save it as UTF-8 and try again.", 'not_utf8');
  if (content.includes('\u0000')) reject("This doesn't look like a text file.", 'binary_content');
  return content;
}

function checkRowCount(count: number): void {
  if (count === 0) reject('No rows were found to import.', 'no_rows');
  if (count > IMPORT_LIMITS.rows) reject(`Imports can have at most ${IMPORT_LIMITS.rows} rows. This one has ${count}. Split it into smaller batches.`, 'too_many_rows');
}

function parseCsv(content: string, batchIssues: ImportIssue[]): CanonicalRow[] {
  let table: string[][];
  try {
    table = parse(content, { bom: true, skip_empty_lines: true, relax_column_count: true, max_record_size: IMPORT_LIMITS.cellChars * 4 });
  } catch (err: any) {
    reject(`The CSV could not be read${err?.lines ? ` near line ${err.lines}` : ''}. Check for unclosed quotes.`, 'csv_parse_error');
  }
  if (!table.length) reject('The CSV is empty.', 'empty_content');
  const headers = table[0].map(normalizeHeader);
  const seen = new Set<string>();
  headers.forEach((header, index) => {
    if (!header) reject(`Column ${index + 1} has no header.`, 'missing_header');
    if (seen.has(header)) reject(`The column "${header}" appears twice.`, 'duplicate_header');
    seen.add(header);
  });
  if (!seen.has('type')) reject('The CSV needs a "type" column. Download the template to see every column.', 'missing_type_column');
  const unknown = headers.filter((header) => !COLUMN_BY_NAME.has(header));
  if (unknown.length) {
    batchIssues.push({ field: 'columns', code: 'unknown_columns', severity: 'warning', message: `These columns are not part of the template and were ignored: ${unknown.slice(0, 10).join(', ')}.` });
  }
  const dataRows = table.slice(1).filter((cells) => cells.some((cell) => String(cell || '').trim()));
  checkRowCount(dataRows.length);
  return dataRows.map((cells, index) => {
    const row = newRow(index + 1);
    if (cells.length > headers.length && cells.slice(headers.length).some((cell) => String(cell || '').trim())) {
      row.issues.push({ field: 'row', code: 'extra_cells', severity: 'error', message: 'This row has more cells than there are columns.' });
    }
    headers.forEach((header, column) => {
      const spec = COLUMN_BY_NAME.get(header);
      if (spec) setField(row, spec, cells[column] ?? '');
    });
    return finishRow(row);
  });
}

function jsonDepth(root: unknown): number {
  let max = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 1 }];
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (value === null || typeof value !== 'object') continue;
    max = Math.max(max, depth);
    if (max > IMPORT_LIMITS.jsonDepth) return max;
    for (const child of Object.values(value as Record<string, unknown>)) stack.push({ value: child, depth: depth + 1 });
  }
  return max;
}

function rowFromObject(item: unknown, rowNumber: number, batchIssues: ImportIssue[], unknownKeys: Set<string>): CanonicalRow {
  const row = newRow(rowNumber);
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    row.issues.push({ field: 'row', code: 'invalid_type', severity: 'error', message: 'Each item must be an object.' });
    return finishRow(row);
  }
  const seen = new Set<string>();
  for (const [rawKey, raw] of Object.entries(item as Record<string, unknown>)) {
    const key = normalizeHeader(rawKey);
    const spec = COLUMN_BY_NAME.get(key);
    if (!spec) {
      unknownKeys.add(key.slice(0, 40));
      continue;
    }
    if (seen.has(key)) {
      row.issues.push({ field: key, code: 'repeated_field', severity: 'error', message: `${key} appears twice in this item.` });
      continue;
    }
    seen.add(key);
    if (raw !== null && typeof raw === 'object' && !(spec.list && Array.isArray(raw))) {
      row.issues.push({ field: key, code: 'invalid_type', severity: 'error', message: `${key} must be ${spec.list ? 'text or a list of text' : 'text'}.` });
      continue;
    }
    setField(row, spec, raw);
  }
  return finishRow(row);
}

function parseJson(content: string, batchIssues: ImportIssue[]): CanonicalRow[] {
  let document: any;
  try {
    document = JSON.parse(content);
  } catch {
    reject('The JSON could not be read. Check it against the template.', 'json_parse_error');
  }
  if (jsonDepth(document) > IMPORT_LIMITS.jsonDepth) reject('The JSON is nested too deeply. Use the template layout.', 'json_too_deep');
  if (!document || typeof document !== 'object' || Array.isArray(document)) reject(`The JSON must be an object with "version" and "items".`, 'json_shape');
  if (document.version !== IMPORT_JSON_VERSION) reject(`Set "version" to "${IMPORT_JSON_VERSION}".`, 'json_version');
  if (!Array.isArray(document.items)) reject('The JSON needs an "items" list.', 'json_shape');
  checkRowCount(document.items.length);
  const unknownKeys = new Set<string>();
  const rows = document.items.map((item: unknown, index: number) => rowFromObject(item, index + 1, batchIssues, unknownKeys));
  if (unknownKeys.size) {
    batchIssues.push({ field: 'items', code: 'unknown_fields', severity: 'warning', message: `These fields are not part of the template and were ignored: ${Array.from(unknownKeys).slice(0, 10).join(', ')}.` });
  }
  return rows;
}

function pasteLabel(line: string): { key: string; value: string; label: string } | null {
  const match = line.match(/^\s*([A-Za-z][A-Za-z _-]{0,29})\s*:\s?(.*)$/);
  const key = match ? PASTE_KEYS[token(match[1])] : undefined;
  return key ? { key, value: match![2], label: match![1].trim() } : null;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

function splitPasteBlocks(content: string): string[][] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines.some((line) => PASTE_SEPARATOR.test(line))) {
    const blocks: string[][] = [[]];
    for (const line of lines) {
      if (PASTE_SEPARATOR.test(line)) blocks.push([]);
      else blocks[blocks.length - 1].push(line);
    }
    return blocks.map(trimBlankEdges).filter((block) => block.length);
  }
  const blocks: string[][] = [];
  let current: string[] = [];
  let keys = new Set<string>();
  let pendingBlank = false;
  for (const line of lines) {
    if (!line.trim()) {
      if (current.length) pendingBlank = true;
      continue;
    }
    const label = pasteLabel(line);
    const startsBlock = pendingBlank && label && BLOCK_START_KEYS.has(label.key)
      && (keys.has('answer_or_instruction') || keys.has(label.key));
    if (startsBlock) {
      blocks.push(current);
      current = [];
      keys = new Set();
    } else if (pendingBlank) {
      current.push('');
    }
    pendingBlank = false;
    if (label && !keys.has('answer_or_instruction')) keys.add(label.key);
    current.push(line);
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function parsePaste(content: string): CanonicalRow[] {
  const blocks = splitPasteBlocks(content);
  checkRowCount(blocks.length);
  return blocks.map((block, index) => {
    const row = newRow(index + 1);
    const collected = new Map<string, string[]>();
    let current = '';
    let inAnswer = false;
    for (const line of block) {
      if (inAnswer) {
        collected.get('answer_or_instruction')!.push(line);
        continue;
      }
      const label = pasteLabel(line);
      if (label) {
        if (collected.has(label.key)) {
          row.issues.push({ field: label.key, code: 'repeated_field', severity: 'error', message: `"${label.label}:" appears twice in this block.` });
          current = '';
          continue;
        }
        collected.set(label.key, [label.value]);
        current = label.key;
        if (label.key === 'answer_or_instruction') inAnswer = true;
      } else if (current) {
        collected.get(current)!.push(line);
      } else if (line.trim()) {
        row.issues.push({ field: 'row', code: 'unlabeled_text', severity: 'error', message: 'Start each entry with a labeled line such as "Q:", "Title:" or "Type:".' });
        current = '';
      }
    }
    if (!collected.has('type') && collected.has('trigger_or_question')) collected.set('type', ['faq']);
    for (const [key, lines] of collected) setField(row, COLUMN_BY_NAME.get(key)!, lines.join('\n'));
    return finishRow(row);
  });
}

export function parseImportSource(raw: unknown): ParsedImportSource {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) reject('The import source is missing.', 'missing_source');
  const source: any = raw;
  const format = String(source.format || '') as ImportFormat;
  if (!(IMPORT_FORMATS as readonly string[]).includes(format)) reject('Choose csv, json, paste or manual.', 'invalid_format');
  const fileName = format === 'csv' || format === 'json' ? cleanFileName(source.fileName) : undefined;
  const batchIssues: ImportIssue[] = [];
  let rows: CanonicalRow[];
  let hashed: string;
  if (format === 'manual') {
    if (!Array.isArray(source.items) || source.items.length !== IMPORT_LIMITS.manualItems) reject('Add exactly one item.', 'manual_items');
    hashed = JSON.stringify(source.items);
    if (Buffer.byteLength(hashed, 'utf8') > IMPORT_LIMITS.contentBytes) reject('This item is too large.', 'too_large');
    if (jsonDepth(source.items) > IMPORT_LIMITS.jsonDepth) reject('The item is nested too deeply.', 'json_too_deep');
    const unknownKeys = new Set<string>();
    rows = source.items.map((item: unknown, index: number) => rowFromObject(item, index + 1, batchIssues, unknownKeys));
    if (unknownKeys.size) {
      batchIssues.push({ field: 'items', code: 'unknown_fields', severity: 'warning', message: `These fields are not part of the template and were ignored: ${Array.from(unknownKeys).slice(0, 10).join(', ')}.` });
    }
  } else {
    hashed = checkTextContent(source.content);
    rows = format === 'csv' ? parseCsv(hashed, batchIssues) : format === 'json' ? parseJson(hashed, batchIssues) : parsePaste(hashed);
  }
  return {
    format,
    fileName,
    contentSha256: crypto.createHash('sha256').update(hashed, 'utf8').digest('hex'),
    contentBytes: Buffer.byteLength(hashed, 'utf8'),
    rows,
    batchIssues,
  };
}

const TEMPLATE_ROWS: Array<Partial<Record<string, string>>> = [
  {
    type: 'rule', title: 'Price questions', location: 'Orem', channels: 'sms|webchat',
    trigger_or_question: 'asks what the price is|asks for the best price',
    answer_or_instruction: 'Never quote prices. Say a sales manager will confirm pricing and offer to set up a visit.',
    handling: 'ask_clarifying', required_questions: 'Which vehicle are you looking at?',
    must_avoid: 'Quoting a price or payment', example_customer: "What's your best price on the Camry?",
    example_reply: 'Happy to help! Which vehicle are you looking at, and when could you come by?',
    source_ref: 'Podium AI > Pricing', source_status: 'on', notes: 'Fictional example',
  },
  {
    type: 'faq', title: 'Saturday hours', location: '', channels: 'sms|webchat|email',
    trigger_or_question: 'Are you open on Saturday?', answer_or_instruction: 'Yes. Sales is open Saturday from 9 to 6.',
    topic: 'hours', source_ref: 'Podium FAQ 12', source_status: 'off',
  },
];

export function importTemplate(format: 'csv' | 'json') {
  const columns = IMPORT_COLUMNS.map((spec) => ({ name: spec.column, list: spec.list, maxLength: spec.max, maxItems: spec.maxItems, description: spec.description }));
  if (format === 'json') {
    const items = TEMPLATE_ROWS.map((row) => Object.fromEntries(IMPORT_COLUMNS
      .filter((spec) => row[spec.column])
      .map((spec) => [spec.column, spec.list ? splitList(row[spec.column] || '') : row[spec.column]])));
    return { format, fileName: 'podium-import-template.json', content: JSON.stringify({ version: IMPORT_JSON_VERSION, items }, null, 2), columns };
  }
  const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines = [IMPORT_COLUMNS.map((spec) => spec.column).join(',')];
  for (const row of TEMPLATE_ROWS) lines.push(IMPORT_COLUMNS.map((spec) => escape(row[spec.column] || '')).join(','));
  return { format, fileName: 'podium-import-template.csv', content: `${lines.join('\r\n')}\r\n`, columns };
}
