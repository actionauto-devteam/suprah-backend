import { importTemplate, IMPORT_LIMITS, parseImportSource } from '../../src/services/aiTrainingImportParser';

const HEADER = 'type,title,location,channels,trigger_or_question,answer_or_instruction,handling,required_questions,must_avoid,source_ref,notes';
const csv = (...lines: string[]) => [HEADER, ...lines].join('\n');
const codes = (row: any) => row.issues.map((issue: any) => issue.code);
const reject = (source: any) => {
  try {
    parseImportSource(source);
  } catch (err: any) {
    return { status: err.statusCode, code: err.errors?.[0]?.code };
  }
  throw new Error('expected rejection');
};

describe('P1b import parser: one canonical schema for every format', () => {
  describe('CSV', () => {
    it('reads quoted cells with commas, quotes and line breaks, BOM and CRLF', () => {
      const content = `\uFEFF${HEADER}\r\nrule,"Price, payments","Orem","sms|webchat","asks about price","Never quote prices.\r\nSay a manager will ""confirm"" it.",ask_clarifying,"Which vehicle?|When can you visit?",Quoting a price,Podium AI > Pricing,Fictional\r\n`;
      const parsed = parseImportSource({ format: 'csv', content, fileName: 'C:\\Users\\me\\podium.csv' });
      expect(parsed.fileName).toBe('podium.csv');
      expect(parsed.rows).toHaveLength(1);
      const values = parsed.rows[0].values;
      expect(values).toMatchObject({
        type: 'rule', title: 'Price, payments', location: 'Orem', channels: ['sms', 'webchat'], handling: 'ask_clarifying',
        answerOrInstruction: 'Never quote prices.\nSay a manager will "confirm" it.', requiredQuestions: ['Which vehicle?', 'When can you visit?'],
      });
      expect(parsed.rows[0].issues).toEqual([]);
      expect(parsed.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('skips empty lines and all-empty rows, numbers data rows from 1', () => {
      const parsed = parseImportSource({ format: 'csv', content: csv('', 'faq,Hours,,,Open Saturday?,Yes from 9 to 6,,,,,', ',,,,,,,,,,', 'tone,Friendly,,,,Keep replies warm,,,,,') });
      expect(parsed.rows.map((row) => row.rowNumber)).toEqual([1, 2]);
      expect(parsed.rows.map((row) => row.values.type)).toEqual(['faq', 'tone']);
    });

    it('treats formula-looking cells as plain text and flags them', () => {
      const parsed = parseImportSource({ format: 'csv', content: csv('rule,"=HYPERLINK(""x"")",,,asks,@SUM(A1) is plain text,,,,,') });
      expect(parsed.rows[0].values.title).toBe('=HYPERLINK("x")');
      expect(codes(parsed.rows[0])).toContain('formula_like');
    });

    it('rejects files with duplicate headers, a missing type column, or broken quotes', () => {
      expect(reject({ format: 'csv', content: 'type,title,Title\nrule,a,b' })).toEqual({ status: 400, code: 'duplicate_header' });
      expect(reject({ format: 'csv', content: 'title,notes\nHello,x' })).toEqual({ status: 400, code: 'missing_type_column' });
      expect(reject({ format: 'csv', content: 'type,title\nrule,"unclosed' })).toEqual({ status: 400, code: 'csv_parse_error' });
    });

    it('flags extra cells, unknown columns, bad channels and bad handling per row', () => {
      const parsed = parseImportSource({ format: 'csv', content: 'type,title,answer_or_instruction,channels,handling,extra_col\nrule,T,Do this,fax,maybe,x,y' });
      expect(parsed.batchIssues.map((issue) => issue.code)).toContain('unknown_columns');
      expect(codes(parsed.rows[0])).toEqual(expect.arrayContaining(['extra_cells', 'invalid_value']));
    });

    it('enforces field and list limits', () => {
      const long = 'x'.repeat(121);
      const parsed = parseImportSource({ format: 'csv', content: csv(`rule,${long},,,asks,Do it,,a|b|c|d|e|f,,,`) });
      expect(codes(parsed.rows[0])).toEqual(expect.arrayContaining(['too_long', 'too_many']));
      expect(parsed.rows[0].values.title).toHaveLength(120);
      expect(parsed.rows[0].values.requiredQuestions).toHaveLength(5);
    });

    it('enforces the row and size limits and rejects text that is not UTF-8', () => {
      const many = Array.from({ length: IMPORT_LIMITS.rows + 1 }, (_, i) => `tone,T${i},,,,Keep it warm,,,,,`);
      expect(reject({ format: 'csv', content: csv(...many) })).toEqual({ status: 400, code: 'too_many_rows' });
      expect(reject({ format: 'csv', content: `${HEADER}\n${'x'.repeat(IMPORT_LIMITS.contentBytes)}` })).toEqual({ status: 400, code: 'too_large' });
      expect(reject({ format: 'csv', content: `${HEADER}\nrule,Caf\uFFFD,,,,x,,,,,` })).toEqual({ status: 400, code: 'not_utf8' });
      expect(reject({ format: 'csv', content: '   ' })).toEqual({ status: 400, code: 'empty_content' });
      expect(reject({ format: 'csv', content: HEADER })).toEqual({ status: 400, code: 'no_rows' });
    });

    it('maps unknown types to unsupported instead of rejecting them, and requires a type', () => {
      const parsed = parseImportSource({ format: 'csv', content: csv('review_request,Ask for reviews,,,,Send a link,,,,,', ',Missing type,,,,Do it,,,,,') });
      expect(parsed.rows[0].unsupportedType).toBe(true);
      expect(codes(parsed.rows[1])).toContain('required');
    });
  });

  describe('JSON', () => {
    const doc = (items: any[], extra: Record<string, unknown> = {}) => JSON.stringify({ version: 'suprah-import-v1', items, ...extra });

    it('accepts list fields as arrays or pipe text and ignores unknown fields', () => {
      const parsed = parseImportSource({ format: 'json', content: doc([{ type: 'rule', title: 'T', trigger_or_question: 'asks', answer_or_instruction: 'Do it', must_avoid: ['A', 'B'], channels: 'sms|email', color: 'red' }]) });
      expect(parsed.rows[0].values.mustAvoid).toEqual(['A', 'B']);
      expect(parsed.rows[0].values.channels).toEqual(['sms', 'email']);
      expect(parsed.batchIssues.map((issue) => issue.code)).toContain('unknown_fields');
    });

    it('rejects the wrong version, the wrong shape, bad JSON and deep nesting', () => {
      expect(reject({ format: 'json', content: JSON.stringify({ version: 'other', items: [] }) })).toEqual({ status: 400, code: 'json_version' });
      expect(reject({ format: 'json', content: '[1,2]' })).toEqual({ status: 400, code: 'json_shape' });
      expect(reject({ format: 'json', content: '{"version":' })).toEqual({ status: 400, code: 'json_parse_error' });
      expect(reject({ format: 'json', content: doc([{ type: 'rule', title: { a: { b: { c: 1 } } } }]) })).toEqual({ status: 400, code: 'json_too_deep' });
    });

    it('flags non-text values per item', () => {
      const parsed = parseImportSource({ format: 'json', content: doc([{ type: 'rule', title: 42, answer_or_instruction: { text: 'x' } }]) });
      expect(codes(parsed.rows[0])).toEqual(expect.arrayContaining(['invalid_type']));
    });
  });

  describe('pasted text', () => {
    it('reads blocks separated by blank lines with Q:/A: and labeled lines, keeping multi-line answers', () => {
      const parsed = parseImportSource({ format: 'paste', content: 'Topic: hours\nStatus: Off\nQ: Are you open Sunday?\nA: No, we are closed Sunday.\nSales reopens Monday.\n\nType: tone\nTitle: Warm tone\nA: Keep replies short and friendly.' });
      expect(parsed.rows).toHaveLength(2);
      expect(parsed.rows[0].values).toMatchObject({ type: 'faq', triggerOrQuestion: 'Are you open Sunday?', answerOrInstruction: 'No, we are closed Sunday.\nSales reopens Monday.', topic: 'hours', sourceStatus: 'off' });
      expect(parsed.rows[1].values).toMatchObject({ type: 'tone', title: 'Warm tone' });
    });

    it('keeps everything after A: in the answer, including "Note:" lines and blank-line paragraphs', () => {
      const parsed = parseImportSource({ format: 'paste', content: 'Q: Do you take trade-ins?\nA: Yes, bring the vehicle by for an appraisal.\nNote: we need the title.\n\nWarning: bring both keys.\nLocation: front desk\n\nQ: Are you open Sunday?\nA: No.' });
      expect(parsed.rows).toHaveLength(2);
      expect(parsed.rows[0].values.answerOrInstruction).toBe('Yes, bring the vehicle by for an appraisal.\nNote: we need the title.\n\nWarning: bring both keys.\nLocation: front desk');
      expect(parsed.rows[0].values.notes).toBe('');
      expect(parsed.rows[0].values.location).toBe('');
      expect(parsed.rows[1].values).toMatchObject({ triggerOrQuestion: 'Are you open Sunday?', answerOrInstruction: 'No.' });
    });

    it('uses --- separators when present, so answers may contain blank lines and labels', () => {
      const parsed = parseImportSource({ format: 'paste', content: 'Location: Orem\nQ: Hours?\nA: Weekdays 9 to 6.\n\nQ: is part of this answer too.\n---\nType: tone\nTitle: Warm\nA: Be warm.\n---\n' });
      expect(parsed.rows).toHaveLength(2);
      expect(parsed.rows[0].values).toMatchObject({ location: 'Orem', answerOrInstruction: 'Weekdays 9 to 6.\n\nQ: is part of this answer too.' });
      expect(parsed.rows[1].values.type).toBe('tone');
    });

    it('flags unlabeled text and repeated labels', () => {
      const parsed = parseImportSource({ format: 'paste', content: 'just some text\nA: answer\n\nQ: one\nQ: two\nA: x' });
      expect(codes(parsed.rows[0])).toContain('unlabeled_text');
      expect(codes(parsed.rows[1])).toContain('repeated_field');
    });
  });

  it('reads the Podium On/Off status in every format and rejects other values', () => {
    const fromCsv = parseImportSource({ format: 'csv', content: 'type,title,answer_or_instruction,status\nfaq,Hours,Open 9 to 6,Enabled\nfaq,Sunday,Closed,OFF\nfaq,Bad,x,maybe' });
    expect(fromCsv.rows.map((row) => row.values.sourceStatus)).toEqual(['on', 'off', '']);
    expect(codes(fromCsv.rows[2])).toContain('invalid_value');
    const fromJson = parseImportSource({ format: 'json', content: JSON.stringify({ version: 'suprah-import-v1', items: [{ type: 'faq', title: 'Hours', trigger_or_question: 'Hours?', answer_or_instruction: 'Open', source_status: 'inactive' }] }) });
    expect(fromJson.rows[0].values.sourceStatus).toBe('off');
  });

  describe('manual item', () => {
    it('takes exactly one item through the same canonical schema', () => {
      const parsed = parseImportSource({ format: 'manual', items: [{ type: 'escalation', title: 'Angry customer', trigger_or_question: 'is upset', answer_or_instruction: 'Apologize and hand off', handling: 'handoff' }] });
      expect(parsed.rows[0].values).toMatchObject({ type: 'escalation', handling: 'escalate' });
      expect(reject({ format: 'manual', items: [] })).toEqual({ status: 400, code: 'manual_items' });
      expect(reject({ format: 'manual', items: [{}, {}] })).toEqual({ status: 400, code: 'manual_items' });
    });
  });

  it('rejects an unknown format', () => {
    expect(reject({ format: 'xlsx', content: 'x' })).toEqual({ status: 400, code: 'invalid_format' });
  });

  it('the downloadable templates parse back cleanly', () => {
    for (const format of ['csv', 'json'] as const) {
      const template = importTemplate(format);
      const parsed = parseImportSource({ format, content: template.content });
      expect(parsed.rows).toHaveLength(2);
      expect(parsed.rows.every((row) => row.issues.every((issue) => issue.severity !== 'error'))).toBe(true);
    }
  });
});
