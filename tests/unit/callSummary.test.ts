import { parseCallSummary } from '../../src/services/callSummary.service';

describe('Call summary parsing', () => {
  it('reads the summary points and the customer sentiment', () => {
    expect(parseCallSummary('{"summary": ["Customer asked if the Tacoma is still available.", "Rep offered a test drive Saturday."], "sentiment": "Interested and friendly."}'))
      .toEqual({ points: ['Customer asked if the Tacoma is still available.', 'Rep offered a test drive Saturday.'], sentiment: 'Interested and friendly.' });
  });
  it('accepts a reply wrapped in a code block or with extra words around it', () => {
    expect(parseCallSummary('```json\n{"summary": ["Voicemail asking for a call back."], "sentiment": "Calm."}\n```')).toEqual({ points: ['Voicemail asking for a call back.'], sentiment: 'Calm.' });
    expect(parseCallSummary('Here it is: {"summary": ["A"], "sentiment": ""} thanks')).toEqual({ points: ['A'], sentiment: '' });
  });
  it('keeps at most four short points and drops empty ones', () => {
    const parsed = parseCallSummary(JSON.stringify({ summary: ['1', '', '2', '3', '4', '5', 'x'.repeat(500)], sentiment: 'ok' }));
    expect(parsed?.points).toEqual(['1', '2', '3', '4']);
    expect(parseCallSummary(JSON.stringify({ summary: ['x'.repeat(500)], sentiment: 'ok' }))?.points[0]).toHaveLength(300);
  });
  it('returns nothing for text that is not a usable summary', () => {
    expect(parseCallSummary('')).toBeNull();
    expect(parseCallSummary('no json here')).toBeNull();
    expect(parseCallSummary('{"summary": [], "sentiment": "ok"}')).toBeNull();
    expect(parseCallSummary('{broken')).toBeNull();
  });
});
