import { readableEmailText } from '../../src/utils/readableEmailText';

const ADF = `<?xml version="1.0"?> <?adf version="1.0"?> <adf> <prospect status="new"> <requestdate>2026-11-25T16:55:00-07:00</requestdate> <vehicle interest="buy" status="used"> <year>2023</year> <make>Toyota</make> <model>RAV4</model> <vin>2T3P1RFV2PC000001</vin> <stock>M00001</stock> <trim>XLE</trim> <odometer units="mi">107336</odometer> <price currency="USD">24796</price> </vehicle> <customer> <contact> <name part="full">Jordan Test</name> <email>jordan.test@example.com</email> <phone type="voice">801-555-0142</phone> </contact> <comments>I'm interested in this "2023 Toyota RAV4 XLE" and I'd like to know if it's still available.</comments> </customer> <vendor> <vendorname>Test Motors Orem</vendorname> </vendor> </prospect> </adf>`;

describe('readableEmailText (what the email bubble shows)', () => {
  it('leaves normal text alone', async () => {
    const text = 'Hi, is the truck still available?\nThanks';
    await expect(readableEmailText(text)).resolves.toBe(text);
  });

  it('leaves text with a stray angle bracket alone', async () => {
    const text = 'Payment must be < $400 a month <3 thanks';
    await expect(readableEmailText(text)).resolves.toBe(text);
  });

  it('turns an email full of HTML tags into plain lines', async () => {
    const html = '<div><b>Vehicle:</b> 2025 Honda Odyssey Sport<br/><b>Price:</b> $33,293<br><b>Color:</b> Red</div><p>To view the listing, click the link below.</p>';
    const text = await readableEmailText(html);
    expect(text).not.toMatch(/<\/?(div|b|br|p)\b/i);
    expect(text).toContain('Vehicle: 2025 Honda Odyssey Sport');
    expect(text).toContain('Price: $33,293');
    expect(text.split('\n').length).toBeGreaterThanOrEqual(3);
  });

  it('shows an ADF lead email as a short summary instead of XML', async () => {
    const text = await readableEmailText(ADF);
    expect(text).not.toContain('<adf');
    expect(text).toBe([
      'Name: Jordan Test',
      'Phone: 801-555-0142',
      'Email: jordan.test@example.com',
      'Vehicle: 2023 Toyota RAV4 XLE (Stock M00001, VIN 2T3P1RFV2PC000001)',
      'Price: $24,796',
      'Comments: I\'m interested in this "2023 Toyota RAV4 XLE" and I\'d like to know if it\'s still available.',
    ].join('\n'));
  });

  it('turns HTML codes in a plain email into the right characters', async () => {
    const text = 'I&#8217;m interested &amp; it&rsquo;s great &#x2014; thanks &quot;Joe&quot;';
    await expect(readableEmailText(text)).resolves.toBe('I’m interested & it’s great — thanks "Joe"');
  });

  it('turns HTML codes into characters after cleaning an HTML email too', async () => {
    const html = '<div>We&rsquo;re open</div><p>Call us &ndash; anytime</p>';
    await expect(readableEmailText(html)).resolves.toBe('We’re open\nCall us – anytime');
  });

  it('leaves unknown or broken codes as they are', async () => {
    const text = 'Price &foo; stays, & alone stays, &#0; stays';
    await expect(readableEmailText(text)).resolves.toBe(text);
  });

  it('keeps empty text empty', async () => {
    await expect(readableEmailText('')).resolves.toBe('');
  });
});
