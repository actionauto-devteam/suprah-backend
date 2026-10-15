import { sanitizeEmailHtml, htmlToPlainText, EMAIL_SAFE_TAGS } from '../../src/utils/emailHtmlSanitizer';

describe('emailHtmlSanitizer — sanitizeEmailHtml', () => {
  it('keeps every tag the TipTap editor configuration can actually produce', () => {
    const input = '<p>Hello <strong>bold</strong> <b>b</b> <em>italic</em> <i>i</i> <u>underline</u></p><h1>H1</h1><h2>H2</h2><h3>H3</h3><ul><li>one</li></ul><ol><li>two</li></ol><a href="https://example.com">link</a><blockquote>quote</blockquote><img src="https://example.com/a.png" alt="A" />';
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

  it('strips inline event handler attributes like onerror/onclick, including on an otherwise-kept img', () => {
    const out = sanitizeEmailHtml('<p onclick="stealData()">Click me</p><img src="https://example.com/a.png" onerror="evil()" />');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('evil(');
    expect(out).toContain('<img');
  });

  it('strips disallowed tags (iframe, style, form) while keeping their safe text content', () => {
    const out = sanitizeEmailHtml('<p>Before</p><iframe src="https://evil.example"></iframe><style>body{display:none}</style><form><input/></form><p>After</p>');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<style');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<input');
    expect(out).toContain('Before');
    expect(out).toContain('After');
  });

  it('keeps an img with an http(s) src, carrying only src/alt plus the forced inline style', () => {
    const out = sanitizeEmailHtml('<img src="https://example.com/banner.png" alt="Banner" class="x" onclick="evil()" />');
    expect(out).toContain('src="https://example.com/banner.png"');
    expect(out).toContain('alt="Banner"');
    expect(out).toContain('style="max-width:100%;height:auto;display:block;margin:8px 0;border-radius:4px"');
    expect(out).not.toContain('class=');
    expect(out).not.toContain('onclick');
  });

  it('blocks javascript: and data: URL schemes on links and on image src', () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">bad</a> <a href="data:text/html,evil">bad2</a> <img src="javascript:alert(1)" /> <img src="data:image/png;base64,evil" />');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('data:text/html');
    expect(out).not.toContain('data:image');
  });

  it('allows http(s) and mailto links and forces safe rel/target', () => {
    const out = sanitizeEmailHtml('<a href="https://example.com">ok</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it('discards a user-supplied style/class/id and replaces it with the forced inline style on allowed tags', () => {
    const out = sanitizeEmailHtml('<p style="color:red" class="x" id="y">text</p>');
    expect(out).not.toContain('color:red');
    expect(out).not.toContain('class=');
    expect(out).not.toContain('id=');
    expect(out).toContain('style="margin:0 0 12px 0"');
  });

  it('forces a readable inline color/underline style onto every link', () => {
    const out = sanitizeEmailHtml('<a href="https://example.com">ok</a>');
    expect(out).toContain('style="color:#2563eb;text-decoration:underline"');
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

  it('represents an image with alt text as a labeled placeholder', () => {
    const text = htmlToPlainText('<p>Before</p><img src="https://example.com/a.png" alt="Our new vehicle" /><p>After</p>');
    expect(text).toContain('[Image: Our new vehicle]');
    expect(text).not.toContain('<img');
  });

  it('represents an image with no alt text as a plain placeholder', () => {
    const text = htmlToPlainText('<img src="https://example.com/a.png" alt="" />');
    expect(text).toBe('[Image]');
  });

  it('returns an empty string for empty input', () => {
    expect(htmlToPlainText('')).toBe('');
  });
});
