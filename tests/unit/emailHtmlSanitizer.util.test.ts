import { sanitizeEmailHtml, htmlToPlainText, EMAIL_SAFE_TAGS } from '../../src/utils/emailHtmlSanitizer';

describe('emailHtmlSanitizer — sanitizeEmailHtml', () => {
  it('keeps every tag the TipTap editor configuration can actually produce', () => {
    const input = '<p>Hello <strong>bold</strong> <b>b</b> <em>italic</em> <i>i</i> <u>underline</u></p><h1>H1</h1><h2>H2</h2><h3>H3</h3><ul><li>one</li></ul><ol><li>two</li></ol><a href="https://example.com">link</a><blockquote>quote</blockquote>';
    const out = sanitizeEmailHtml(input);
    for (const tag of EMAIL_SAFE_TAGS) {
      if (tag === 'br') continue;
      expect(out).toContain(`<${tag}`);
    }
  });

  it('strips <script> tags and their content entirely', () => {
    const out = sanitizeEmailHtml('<p>Hi</p><script>alert(document.cookie)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(');
  });

  it('strips inline event handler attributes like onerror/onclick', () => {
    const out = sanitizeEmailHtml('<p onclick="stealData()">Click me</p><img src="x" onerror="evil()" />');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('<img');
  });

  it('strips disallowed tags (img, iframe, style, form) while keeping their safe text content', () => {
    const out = sanitizeEmailHtml('<p>Before</p><iframe src="https://evil.example"></iframe><style>body{display:none}</style><form><input/></form><p>After</p>');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<style');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<input');
    expect(out).toContain('Before');
    expect(out).toContain('After');
  });

  it('blocks javascript: and data: URL schemes on links', () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">bad</a> <a href="data:text/html,evil">bad2</a>');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('data:text/html');
  });

  it('allows http(s) and mailto links and forces safe rel/target', () => {
    const out = sanitizeEmailHtml('<a href="https://example.com">ok</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it('strips style/class/id attributes even on allowed tags', () => {
    const out = sanitizeEmailHtml('<p style="color:red" class="x" id="y">text</p>');
    expect(out).not.toContain('style=');
    expect(out).not.toContain('class=');
    expect(out).not.toContain('id=');
  });

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(sanitizeEmailHtml('')).toBe('');
    expect(sanitizeEmailHtml('   ')).toBe('');
  });
});

describe('emailHtmlSanitizer — htmlToPlainText', () => {
  it('converts paragraphs into separate lines instead of one run-on string', () => {
    const text = htmlToPlainText('<p>First paragraph</p><p>Second paragraph</p>');
    expect(text).toBe('First paragraph\n\nSecond paragraph');
  });

  it('converts list items into bulleted lines', () => {
    const text = htmlToPlainText('<ul><li>Apples</li><li>Oranges</li></ul>');
    expect(text).toContain('• Apples');
    expect(text).toContain('• Oranges');
  });

  it('converts <br> into a newline', () => {
    const text = htmlToPlainText('<p>Line one<br>Line two</p>');
    expect(text).toBe('Line one\nLine two');
  });

  it('decodes common HTML entities', () => {
    const text = htmlToPlainText('<p>Tom &amp; Jerry &mdash; &quot;fun&quot; &nbsp; done</p>');
    expect(text).toContain('Tom & Jerry');
    expect(text).toContain('"fun"');
  });

  it('strips any tags that survive into plain text, including script content removed upstream', () => {
    const text = htmlToPlainText('<p>Safe</p><script>evil()</script>');
    expect(text).not.toContain('<');
    expect(text).not.toContain('evil(');
  });

  it('returns an empty string for empty input', () => {
    expect(htmlToPlainText('')).toBe('');
  });
});
