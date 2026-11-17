import { parseADF, parseEmailBody } from '../../src/utils/adfParser';

const contact = (name: string, email: string, phone: string, extra = '') => `<contact${extra}>
        <name part="full">${name}</name>
        <email>${email}</email>
        <phone type="voice">${phone}</phone>
        <address><street>12 Test Way</street><city>Orem</city><regioncode>UT</regioncode><postalcode>84057</postalcode></address>
      </contact>`;

const adf = (customerXml: string) => `<?xml version="1.0"?>
<?adf version="1.0"?>
<adf>
  <prospect status="new">
    <requestdate>2026-11-16T18:08:00-07:00</requestdate>
    <vehicle interest="buy" status="used"><id sequence="1">ST-1</id><year>2020</year><make>TOYOTA</make><model>TACOMA</model></vehicle>
    ${customerXml}
    <vendor><name part="full">Test Motors Orem</name></vendor>
    <provider><name part="full">Credit Application</name><email>apps@example.com</email></provider>
  </prospect>
</adf>`;

describe('ADF leads with an applicant and a co-applicant', () => {
  it('reads the first person as the lead and keeps the second as a co-applicant', async () => {
    const parsed = await parseADF(adf(`<customer>
      ${contact('Sam Rivera', 'sam.rivera@example.com', '801-555-0101')}
      <comments>Primary applicant</comments>
      ${contact('Alex Moreno', 'alex.moreno@example.com', '801-555-0102')}
      <comments>Co-applicant</comments>
    </customer>`));
    expect(parsed?.firstName).toBe('Sam');
    expect(parsed?.lastName).toBe('Rivera');
    expect(parsed?.email).toBe('sam.rivera@example.com');
    expect(parsed?.phone).toBe('801-555-0101');
    expect(parsed?.comments).toBe('Primary applicant');
    expect(parsed?.rawFields.city).toBe('Orem');
    expect(parsed?.coApplicants).toEqual([{ firstName: 'Alex', lastName: 'Moreno', email: 'alex.moreno@example.com', phone: '801-555-0102' }]);
    expect(parsed?.parsedContent).toContain('Name: Sam Rivera');
    expect(parsed?.parsedContent).toContain('— Co-applicant —\nName: Alex Moreno\nEmail: alex.moreno@example.com\nPhone: 801-555-0102');
    expect(parsed?.parsedContent).not.toContain('Name: Unknown');
    expect(parsed?.parsedContent).toContain('Request Date: 11/16/2026, 6:08:00 PM');
  });

  it('uses the contact marked as primary when the ADF marks one', async () => {
    const parsed = await parseADF(adf(`<customer>
      ${contact('Alex Moreno', 'alex.moreno@example.com', '801-555-0102')}
      ${contact('Sam Rivera', 'sam.rivera@example.com', '801-555-0101', ' primarycontact="1"')}
    </customer>`));
    expect(parsed?.firstName).toBe('Sam');
    expect(parsed?.phone).toBe('801-555-0101');
    expect(parsed?.coApplicants?.map((person) => person.firstName)).toEqual(['Alex']);
  });

  it('reads two separate customer blocks', async () => {
    const parsed = await parseADF(adf(`<customer>${contact('Sam Rivera', 'sam.rivera@example.com', '801-555-0101')}<comments>Hello</comments></customer>
    <customer>${contact('Alex Moreno', 'alex.moreno@example.com', '801-555-0102')}</customer>`));
    expect(parsed?.firstName).toBe('Sam');
    expect(parsed?.email).toBe('sam.rivera@example.com');
    expect(parsed?.comments).toBe('Hello');
    expect(parsed?.coApplicants?.[0]?.lastName).toBe('Moreno');
  });

  it('skips an empty first contact', async () => {
    const parsed = await parseADF(adf(`<customer><contact></contact>${contact('Sam Rivera', 'sam.rivera@example.com', '801-555-0101')}</customer>`));
    expect(parsed?.firstName).toBe('Sam');
    expect(parsed?.phone).toBe('801-555-0101');
    expect(parsed?.coApplicants).toBeUndefined();
  });

  it('keeps one-person leads exactly as before', async () => {
    const parsed = await parseADF(adf(`<customer><contact><name part="first">Pat</name><name part="last">Lee</name><email>pat@example.com</email><phone>385-555-0199</phone></contact><comments>Is it available?</comments></customer>`));
    expect(parsed?.firstName).toBe('Pat');
    expect(parsed?.lastName).toBe('Lee');
    expect(parsed?.email).toBe('pat@example.com');
    expect(parsed?.phone).toBe('385-555-0199');
    expect(parsed?.comments).toBe('Is it available?');
    expect(parsed).not.toHaveProperty('coApplicants');
    expect(parsed?.parsedContent).not.toContain('Co-applicant');
  });

  it('does not fail when a name part is empty', async () => {
    const parsed = await parseADF(adf(`<customer><contact><name part="first"></name><name part="last">Lee</name><phone>385-555-0199</phone></contact></customer>`));
    expect(parsed?.firstName).toBe('Unknown');
    expect(parsed?.lastName).toBe('Lee');
    expect(parsed?.phone).toBe('385-555-0199');
  });

  it('reads a two-person ADF inside a lead email body', async () => {
    const body = `New credit application\n\n${adf(`<customer>
      ${contact('Sam Rivera', 'sam.rivera@example.com', '801-555-0101')}
      ${contact('Alex Moreno', 'alex.moreno@example.com', '801-555-0102')}
    </customer>`)}`;
    const result = await parseEmailBody(body, 'Credit application lead', 'leads@example.com');
    expect(result.channel).toBe('adf');
    expect(result.adfData?.firstName).toBe('Sam');
    expect(result.adfData?.phone).toBe('801-555-0101');
    expect(result.parsedContent).toContain('Alex Moreno');
  });
});
