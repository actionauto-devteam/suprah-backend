import {
  classifyCustomerArea,
  customerAreaFilterCondition,
  customerAreaFromAddress,
  customerAreaFromPhone,
  leadCustomerArea,
  postalAddressLine,
  sameCustomerArea,
} from '../../src/utils/customerArea';

const utahPhone = { code: 'utah', basis: 'phone', detail: '801' };

describe('Customer area from the phone number', () => {
  it('reads Salt Lake and Utah County numbers (801, 385) as Utah in any common format', () => {
    expect(customerAreaFromPhone('801-555-0123')).toEqual(utahPhone);
    expect(customerAreaFromPhone('(385) 230-3168')).toEqual({ code: 'utah', basis: 'phone', detail: '385' });
    expect(customerAreaFromPhone('+18015550123')).toEqual(utahPhone);
    expect(customerAreaFromPhone('1 801 555 0123')).toEqual(utahPhone);
    expect(customerAreaFromPhone('8015550123')).toEqual(utahPhone);
  });

  it('keeps 435 apart, because it covers both nearby and far parts of Utah', () => {
    expect(customerAreaFromPhone('435-555-0142')).toEqual({ code: 'utah_435', basis: 'phone', detail: '435' });
  });

  it('reads other US area codes as out of state and keeps the area code', () => {
    expect(customerAreaFromPhone('952-855-4444')).toEqual({ code: 'out_of_state', basis: 'phone', detail: '952' });
    expect(customerAreaFromPhone('(949) 842-3856')).toEqual({ code: 'out_of_state', basis: 'phone', detail: '949' });
    expect(customerAreaFromPhone('+1 702 555 0188')).toEqual({ code: 'out_of_state', basis: 'phone', detail: '702' });
    expect(customerAreaFromPhone('787-555-0199')).toEqual({ code: 'out_of_state', basis: 'phone', detail: '787' });
  });

  it('reads Canada and other countries from the number', () => {
    expect(customerAreaFromPhone('416-555-0133')).toEqual({ code: 'canada', basis: 'phone', detail: '416' });
    expect(customerAreaFromPhone('+52 55 1234 5678')).toMatchObject({ code: 'outside_us', basis: 'phone', detail: 'MX' });
    expect(customerAreaFromPhone('+63 917 845 2210')).toMatchObject({ code: 'outside_us', basis: 'phone', detail: 'PH' });
  });

  it('gives no area for toll-free, missing or broken numbers', () => {
    expect(customerAreaFromPhone('800-555-0100')).toBeNull();
    expect(customerAreaFromPhone('888-555-0100')).toBeNull();
    expect(customerAreaFromPhone('')).toBeNull();
    expect(customerAreaFromPhone(undefined)).toBeNull();
    expect(customerAreaFromPhone('555-0100')).toBeNull();
    expect(customerAreaFromPhone('call me')).toBeNull();
    expect(customerAreaFromPhone('801-555-0123 cell')).toBeNull();
    expect(customerAreaFromPhone('801-111-1111')).toBeNull();
  });

  it('gives no area for made-up numbers that are still valid phone numbers', () => {
    expect(customerAreaFromPhone('801-555-5555')).toBeNull();
    expect(customerAreaFromPhone('435-222-2222')).toBeNull();
    expect(customerAreaFromPhone('702-123-4567')).toBeNull();
  });

  it('ignores an extension', () => {
    expect(customerAreaFromPhone('801-555-0123 ext 22')).toEqual(utahPhone);
    expect(customerAreaFromPhone('801-555-0123 x22')).toEqual(utahPhone);
  });
});

describe('Customer area from the address', () => {
  it('reads a Utah ZIP code, with or without the state', () => {
    expect(customerAreaFromAddress('1979 west floisand circle, SALT LAKE CITY, UT, 84116')).toEqual({ code: 'utah', basis: 'zip', detail: '84116' });
    expect(customerAreaFromAddress('123 Main St, Lehi, UT 84043')).toEqual({ code: 'utah', basis: 'zip', detail: '84043' });
    expect(customerAreaFromAddress('Lehi UT 84043-1234')).toEqual({ code: 'utah', basis: 'zip', detail: '84043' });
    expect(customerAreaFromAddress('450 W 800 N Orem 84057')).toEqual({ code: 'utah', basis: 'zip', detail: '84057' });
    expect(customerAreaFromAddress('84043')).toEqual({ code: 'utah', basis: 'zip', detail: '84043' });
    expect(customerAreaFromAddress('12 Elm St, Provo, UT 84601, USA')).toEqual({ code: 'utah', basis: 'zip', detail: '84601' });
    expect(customerAreaFromAddress('123 Main St Apt, 84043')).toEqual({ code: 'utah', basis: 'zip', detail: '84043' });
    expect(customerAreaFromAddress('1234 S 500 W 84043')).toEqual({ code: 'utah', basis: 'zip', detail: '84043' });
    expect(customerAreaFromAddress('123 W Center St 84057')).toEqual({ code: 'utah', basis: 'zip', detail: '84057' });
    expect(customerAreaFromAddress('13400 S 1234 W Riverton 84065')).toEqual({ code: 'utah', basis: 'zip', detail: '84065' });
    expect(customerAreaFromAddress('EAGLE MT 84005')).toEqual({ code: 'utah', basis: 'zip', detail: '84005' });
    expect(customerAreaFromAddress('1234 E PONY EXPRESS PKWY, EAGLE MT, UT, 84005')).toEqual({ code: 'utah', basis: 'zip', detail: '84005' });
    expect(customerAreaFromAddress('Redwood Road 84123')).toEqual({ code: 'utah', basis: 'zip', detail: '84123' });
  });

  it('reads a ZIP+4 written without a hyphen, and skips a junk last part to find the state', () => {
    expect(customerAreaFromAddress('Lehi UT 84043 1234')).toEqual({ code: 'utah', basis: 'zip', detail: '84043' });
    expect(customerAreaFromAddress('123 Main St, Sandy, UT, 840701234')).toEqual({ code: 'utah', basis: 'zip', detail: '84070' });
    expect(customerAreaFromAddress('123 Main St, Sandy, UT, N/A')).toEqual({ code: 'utah', basis: 'state', detail: 'UT' });
    expect(customerAreaFromAddress('123 Main St, Sandy, UT, 84070-')).toEqual({ code: 'utah', basis: 'state', detail: 'UT' });
  });

  it('reads 847 ZIP codes (St. George, Cedar City) as Southern Utah', () => {
    expect(customerAreaFromAddress('55 S 700 E, St George, UT 84770')).toEqual({ code: 'southern_utah', basis: 'zip', detail: '84770' });
    expect(customerAreaFromAddress('Cedar City UT 84720')).toEqual({ code: 'southern_utah', basis: 'zip', detail: '84720' });
    expect(customerAreaFromAddress('84790')).toEqual({ code: 'southern_utah', basis: 'zip', detail: '84790' });
    expect(customerAreaFromAddress('Washington, UT 84780')).toEqual({ code: 'southern_utah', basis: 'zip', detail: '84780' });
    expect(customerAreaFromAddress('2450 E Riverside Dr 84790')).toEqual({ code: 'southern_utah', basis: 'zip', detail: '84790' });
  });

  it('reads the state when there is no ZIP code', () => {
    expect(customerAreaFromAddress('Sandy UT')).toEqual({ code: 'utah', basis: 'state', detail: 'UT' });
    expect(customerAreaFromAddress('sandy, ut')).toEqual({ code: 'utah', basis: 'state', detail: 'UT' });
    expect(customerAreaFromAddress('1234 S Main St Sandy UT')).toEqual({ code: 'utah', basis: 'state', detail: 'UT' });
    expect(customerAreaFromAddress('Orem, Utah')).toEqual({ code: 'utah', basis: 'state', detail: 'UT' });
    expect(customerAreaFromAddress('UT')).toEqual({ code: 'utah', basis: 'state', detail: 'UT' });
    expect(customerAreaFromAddress('St George, UT')).toEqual({ code: 'utah', basis: 'state', detail: 'UT' });
    expect(customerAreaFromAddress('Washington, UT')).toEqual({ code: 'utah', basis: 'state', detail: 'UT' });
    expect(customerAreaFromAddress('Sandy, UT, 00000')).toEqual({ code: 'utah', basis: 'state', detail: 'UT' });
  });

  it('reads other states as out of state and keeps the state', () => {
    expect(customerAreaFromAddress('Las Vegas, NV 89101')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'NV' });
    expect(customerAreaFromAddress('Las Vegas Nevada')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'NV' });
    expect(customerAreaFromAddress('Denver, CO')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'CO' });
    expect(customerAreaFromAddress('Las Vegas NV')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'NV' });
    expect(customerAreaFromAddress('boise, id')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'ID' });
    expect(customerAreaFromAddress('Charleston, West Virginia')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'WV' });
    expect(customerAreaFromAddress('Seattle, Washington 98101')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'WA' });
    expect(customerAreaFromAddress('Seattle, WA')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'WA' });
    expect(customerAreaFromAddress('1600 Pennsylvania Ave NW, Washington DC')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'DC' });
    expect(customerAreaFromAddress('100 Main St, CA')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'CA' });
    expect(customerAreaFromAddress('NV')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'NV' });
    expect(customerAreaFromAddress('NV, 89101')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'NV' });
    expect(customerAreaFromAddress('90210')).toEqual({ code: 'out_of_state', basis: 'zip', detail: '90210' });
    expect(customerAreaFromAddress('Beverly Hills 90210')).toEqual({ code: 'out_of_state', basis: 'zip', detail: '90210' });
  });

  it('reads the state of a one-line address when a real ZIP code follows it', () => {
    expect(customerAreaFromAddress('123 Main St Denver CO 80202')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'CO' });
    expect(customerAreaFromAddress('500 W Idaho St Boise ID 83702')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'ID' });
    expect(customerAreaFromAddress('las vegas nv 89101')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'NV' });
    expect(customerAreaFromAddress('100 Main St Evanston WY 82930')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'WY' });
    expect(customerAreaFromAddress('12 Test Way, CT, 06103')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'CT' });
    expect(customerAreaFromAddress('123 Main St Reno Nevada 89501')).toEqual({ code: 'out_of_state', basis: 'state', detail: 'NV' });
    expect(customerAreaFromAddress('742 EVERGREEN CT 84070')).toEqual({ code: 'utah', basis: 'zip', detail: '84070' });
    expect(customerAreaFromAddress('Coral Canyon, Washington 84780')).toEqual({ code: 'southern_utah', basis: 'zip', detail: '84780' });
    expect(customerAreaFromAddress('Denver CO 12345')).toBeNull();
  });

  it('trusts a Utah ZIP over a wrong state, and a Utah state over a wrong ZIP', () => {
    expect(customerAreaFromAddress('Fairfield, CA 84043')).toEqual({ code: 'utah', basis: 'zip', detail: '84043' });
    expect(customerAreaFromAddress('Provo, UT 90210')).toEqual({ code: 'utah', basis: 'state', detail: 'UT' });
  });

  it('reads Canada from the province, the postal code or the country', () => {
    expect(customerAreaFromAddress('100 King St W, Toronto, ON M5X 1A9')).toEqual({ code: 'canada', basis: 'zip', detail: 'M5X 1A9' });
    expect(customerAreaFromAddress('Vancouver, BC')).toEqual({ code: 'canada', basis: 'state', detail: 'BC' });
    expect(customerAreaFromAddress('Toronto, ON')).toEqual({ code: 'canada', basis: 'state', detail: 'ON' });
    expect(customerAreaFromAddress('Calgary, Alberta, Canada')).toEqual({ code: 'canada', basis: 'state', detail: 'AB' });
    expect(customerAreaFromAddress('Toronto Ontario Canada')).toEqual({ code: 'canada', basis: 'state', detail: 'ON' });
    expect(customerAreaFromAddress('Montréal, Québec')).toEqual({ code: 'canada', basis: 'state', detail: 'QC' });
    expect(customerAreaFromAddress('Montreal, Canada')).toEqual({ code: 'canada', basis: 'state', detail: 'Canada' });
    expect(customerAreaFromAddress('Canada')).toEqual({ code: 'canada', basis: 'state', detail: 'Canada' });
  });

  it('does not treat a made-up ZIP code, a box number or a street number as a ZIP code', () => {
    for (const address of ['00000', 'Sandy, 00000', '99999', '11111', '12345', 'PO Box 12345', 'PO Box 84123', 'Suite 10500', 'Suite 84500', 'HC 65 Box 84720']) {
      expect(customerAreaFromAddress(address)).toBeNull();
    }
    for (const address of ['1234 W 10400', '2700 W 13400', '12345 S 1300 E', '1234 S 400 E']) {
      expect(customerAreaFromAddress(address)).toBeNull();
    }
    for (const address of ['1234 West 10400', '1234 South 13400', '1234 West 13400 South', '13400 S 1234 W, Riverton', '12 Test Way Reno 89501', 'Space 84043', '# 84101', 'Redwood Road 12600', 'State Street 10600', 'PMB 10234']) {
      expect(customerAreaFromAddress(address)).toBeNull();
    }
  });

  it('does not guess a state from a street ending, a short word or a city that shares a state name', () => {
    for (const address of ['742 Evergreen CT', '4 King WY', 'APT 4 742 EVERGREEN CT', '#4 742 Evergreen CT', '123 4th St, NE', '123 Georgia', 'denver co']) {
      expect(customerAreaFromAddress(address)).toBeNull();
    }
    for (const address of ['Washington', '123 Main St, Washington', 'Ontario', 'OK', 'ok', 'N/A', 'St George', 'Columbus', '']) {
      expect(customerAreaFromAddress(address)).toBeNull();
    }
    for (const address of ['EAGLE MT', '1234 E PONY EXPRESS PKWY, EAGLE MT', 'SALT LAKE CO', 'Utah Co', '3500 S 4000 W, WV', 'Denver CO', 'Boise ID', 'CALL ME', 'Main St NE']) {
      expect(customerAreaFromAddress(address)).toBeNull();
    }
    for (const address of ['Coral Canyon, Washington', 'PO Box 123, Washington', 'Telegraph St Washington', 'Seattle, Washington', 'PO Box 5, Ontario']) {
      expect(customerAreaFromAddress(address)).toBeNull();
    }
    expect(customerAreaFromAddress(undefined)).toBeNull();
  });

  it('does not read a Mexican or Caribbean address as Canada or as a US state', () => {
    expect(customerAreaFromAddress('Av. Revolucion 123, Tijuana, BC, 22000')).toBeNull();
    expect(customerAreaFromAddress('Monterrey, NL, 64000')).toBeNull();
    expect(customerAreaFromAddress('Mexicali, Baja California')).toBeNull();
    expect(customerAreaFromAddress('Road Town, British Virgin Islands')).toBeNull();
    expect(customerAreaFromAddress('La Canada')).toBeNull();
    expect(customerAreaFromAddress('1234 Foothill Blvd, La Canada')).toBeNull();
  });

  it('stays fast on a very long address and still reads its ending', () => {
    const started = Date.now();
    expect(customerAreaFromAddress(`a${','.repeat(200000)}b`)).toBeNull();
    expect(customerAreaFromAddress(`${'x'.repeat(200000)}, Sandy, UT 84070`)).toEqual({ code: 'utah', basis: 'zip', detail: '84070' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('Address line built from DealersCloud parts', () => {
  it('joins street, city, state and ZIP, and leaves out the parts that are missing', () => {
    expect(postalAddressLine({ street: '12 Test Way', city: 'Orem', state: 'UT', zip: '84057' })).toBe('12 Test Way, Orem, UT, 84057');
    expect(postalAddressLine({ street: '  12   Test\nWay ', city: 'Orem', state: '', zip: '84057' })).toBe('12 Test Way, Orem, 84057');
    expect(postalAddressLine({ state: 'NV' })).toBe('NV');
    expect(postalAddressLine({ vin: '1HG', stockNumber: 'A1' } as any)).toBe('');
    expect(postalAddressLine(undefined)).toBe('');
    expect(postalAddressLine(null)).toBe('');
    expect(postalAddressLine({ street: 's'.repeat(400), city: 'Orem' })).toHaveLength(300);
  });

  it('gives the same area as the saved parts say', () => {
    expect(customerAreaFromAddress(postalAddressLine({ street: '9 Elm St', city: 'Cedar City', state: 'UT', zip: '84720' }))).toEqual({ code: 'southern_utah', basis: 'zip', detail: '84720' });
    expect(customerAreaFromAddress(postalAddressLine({ city: 'Reno', state: 'NV' }))).toEqual({ code: 'out_of_state', basis: 'state', detail: 'NV' });
    expect(customerAreaFromAddress(postalAddressLine({ zip: '84043' }))).toEqual({ code: 'utah', basis: 'zip', detail: '84043' });
    expect(customerAreaFromAddress(postalAddressLine({ street: '123 Main St' }))).toBeNull();
  });
});

describe('Customer area for a lead', () => {
  it('uses the address first and the phone only when the address says nothing', () => {
    expect(classifyCustomerArea({ address: 'Sandy, UT 84070', phone: '949-555-0111' })).toEqual({ code: 'utah', basis: 'zip', detail: '84070' });
    expect(classifyCustomerArea({ address: 'Reno, NV', phone: '801-555-0111' })).toEqual({ code: 'out_of_state', basis: 'state', detail: 'NV' });
    expect(classifyCustomerArea({ address: '742 Evergreen Terrace', phone: '801-555-0111' })).toEqual(utahPhone);
    expect(classifyCustomerArea({ address: '00000', phone: '801-555-0111' })).toEqual(utahPhone);
    expect(classifyCustomerArea({ address: '1234 W 10400', phone: '801-555-0111' })).toEqual(utahPhone);
    expect(classifyCustomerArea({ address: '1234 West 13400', phone: '801-555-0111' })).toEqual(utahPhone);
    expect(classifyCustomerArea({ address: 'EAGLE MT', phone: '801-555-0111' })).toEqual(utahPhone);
    expect(classifyCustomerArea({ address: 'Coral Canyon, Washington', phone: '435-555-0111' })).toEqual({ code: 'utah_435', basis: 'phone', detail: '435' });
    expect(classifyCustomerArea({ address: '123 Main St, Washington', phone: '435-555-0111' })).toEqual({ code: 'utah_435', basis: 'phone', detail: '435' });
    expect(classifyCustomerArea({ address: '', phone: '' })).toBeNull();
    expect(classifyCustomerArea({})).toBeNull();
  });

  it('reads a lead from its own phone and address only', () => {
    expect(leadCustomerArea({ phone: '435-555-0142' })).toEqual({ code: 'utah_435', basis: 'phone', detail: '435' });
    expect(leadCustomerArea({ address: 'Hurricane, UT 84737', phone: '801-555-0142' })).toEqual({ code: 'southern_utah', basis: 'zip', detail: '84737' });
    expect(leadCustomerArea({ normalizedPhone: '+13855550142' } as any)).toBeNull();
    expect(leadCustomerArea(null)).toBeNull();
  });

  it('compares two saved areas', () => {
    expect(sameCustomerArea(null, undefined)).toBe(true);
    expect(sameCustomerArea({ code: 'utah', basis: 'phone', detail: '801' }, { code: 'utah', basis: 'phone', detail: '801' })).toBe(true);
    expect(sameCustomerArea({ code: 'utah', basis: 'phone', detail: '801' }, { code: 'utah', basis: 'zip', detail: '84043' })).toBe(false);
    expect(sameCustomerArea({ code: 'utah', basis: 'phone', detail: '801' }, null)).toBe(false);
  });
});

describe('Customer area filter', () => {
  it('turns each filter choice into a lead condition and ignores anything else', () => {
    expect(customerAreaFilterCondition('utah')).toEqual({ 'customerArea.code': 'utah' });
    expect(customerAreaFilterCondition('Utah_435')).toEqual({ 'customerArea.code': 'utah_435' });
    expect(customerAreaFilterCondition('southern_utah')).toEqual({ 'customerArea.code': 'southern_utah' });
    expect(customerAreaFilterCondition('out_of_state')).toEqual({ 'customerArea.code': 'out_of_state' });
    expect(customerAreaFilterCondition('outside')).toEqual({ 'customerArea.code': { $in: ['canada', 'outside_us'] } });
    expect(customerAreaFilterCondition('none')).toEqual({ 'customerArea.code': null });
    expect(customerAreaFilterCondition('')).toBeNull();
    expect(customerAreaFilterCondition(undefined)).toBeNull();
    expect(customerAreaFilterCondition({ $ne: null })).toBeNull();
    expect(customerAreaFilterCondition('texas')).toBeNull();
  });
});
