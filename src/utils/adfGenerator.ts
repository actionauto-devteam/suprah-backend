
export interface ADFLeadData {
  prospect: {
    requestDate?: string;
    customer: {
      contact: {
        name: { part: 'first' | 'last' | 'full'; value: string }[];
        email: string;
        phone: string;
        address?: {
          street?: string;
          city?: string;
          regioncode?: string;
          postalcode?: string;
        };
      };
      comments?: string;
    };
    vehicle: {
      interest: 'buy' | 'lease' | 'trade-in' | 'test-drive';
      status: 'new' | 'used';
      year: string;
      make: string;
      model: string;
      vin?: string;
      stock?: string;
      trim?: string;
      price?: string;
    };
    provider: {
      name: string;
      service?: string;
      url?: string;
    };
    vendor?: {
      name: string;
      id?: { source: string; value: string };
      contact?: {
        name?: string;
        email?: string;
        phone?: string;
        address?: {
          street?: string;
          city?: string;
          regioncode?: string;
          postalcode?: string;
        };
      };
    };
  };
}

function escapeXml(unsafe: string): string {
  if (!unsafe) return '';
  return unsafe.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      default: return c;
    }
  });
}

export function generateInquiryADF(data: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  comments?: string;
  vehicle: {
    year: number | string;
    make: string;
    model: string;
    vin?: string;
    stockNumber?: string;
    price?: number | string;
  };
}): string {
  return generateADF({
    prospect: {
      customer: {
        contact: {
          name: [
            { part: 'first', value: data.firstName },
            { part: 'last', value: data.lastName },
          ],
          email: data.email,
          phone: data.phone,
        },
        comments: data.comments,
      },
      vehicle: {
        interest: 'buy',
        status: 'used',
        year: data.vehicle.year.toString(),
        make: data.vehicle.make,
        model: data.vehicle.model,
        vin: data.vehicle.vin,
        stock: data.vehicle.stockNumber,
        price: data.vehicle.price?.toString(),
      },
      provider: {
        name: 'Suprah.AI Digital Retail',
      },
    },
  });
}

export function generateADF(data: ADFLeadData): string {
  const { prospect } = data;
  const requestDate = prospect.requestDate || new Date().toISOString();

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<?adf version="1.0"?>\n`;
  xml += `<adf>\n`;
  xml += `  <prospect>\n`;
  xml += `    <requestdate>${requestDate}</requestdate>\n`;

  // 2. Vehicle Section
  const v = prospect.vehicle;
  xml += `    <vehicle interest="${v.interest}" status="${escapeXml(v.status)}">\n`;
  xml += `      <year>${escapeXml(v.year)}</year>\n`;
  xml += `      <make>${escapeXml(v.make)}</make>\n`;
  xml += `      <model>${escapeXml(v.model)}</model>\n`;
  if (v.trim) xml += `      <trim>${escapeXml(v.trim)}</trim>\n`;
  if (v.vin) xml += `      <vin>${escapeXml(v.vin)}</vin>\n`;
  if (v.stock) xml += `      <stock>${escapeXml(v.stock)}</stock>\n`;
  if (v.price) xml += `      <price>${escapeXml(v.price)}</price>\n`;
  xml += `    </vehicle>\n`;

  // 3. Customer Section
  const c = prospect.customer.contact;
  xml += `    <customer>\n`;
  xml += `      <contact>\n`;
  
  // Names
  c.name.forEach((n) => {
    xml += `        <name part="${n.part}">${escapeXml(n.value)}</name>\n`;
  });

  xml += `        <email>${escapeXml(c.email)}</email>\n`;
  xml += `        <phone>${escapeXml(c.phone)}</phone>\n`;

  if (c.address) {
    xml += `        <address>\n`;
    if (c.address.street) xml += `          <street line="1">${escapeXml(c.address.street)}</street>\n`;
    if (c.address.city) xml += `          <city>${escapeXml(c.address.city)}</city>\n`;
    if (c.address.regioncode) xml += `          <regioncode>${escapeXml(c.address.regioncode)}</regioncode>\n`;
    if (c.address.postalcode) xml += `          <postalcode>${escapeXml(c.address.postalcode)}</postalcode>\n`;
    xml += `        </address>\n`;
  }
  
  xml += `      </contact>\n`;
  if (prospect.customer.comments) {
    xml += `      <comments>${escapeXml(prospect.customer.comments)}</comments>\n`;
  }
  xml += `    </customer>\n`;

  // 4. Vendor Section (Target Dealership)
  if (prospect.vendor) {
    const v = prospect.vendor;
    xml += `    <vendor>\n`;
    if (v.id) xml += `      <id source="${escapeXml(v.id.source)}">${escapeXml(v.id.value)}</id>\n`;
    xml += `      <vendorname>${escapeXml(v.name)}</vendorname>\n`;
    if (v.contact) {
      xml += `      <contact>\n`;
      if (v.contact.name) xml += `        <name part="full">${escapeXml(v.contact.name)}</name>\n`;
      if (v.contact.email) xml += `        <email>${escapeXml(v.contact.email)}</email>\n`;
      if (v.contact.phone) xml += `        <phone>${escapeXml(v.contact.phone)}</phone>\n`;
      
      const addr = v.contact.address;
      if (addr) {
        xml += `        <address>\n`;
        if (addr.street) xml += `          <street line="1">${escapeXml(addr.street)}</street>\n`;
        if (addr.city) xml += `          <city>${escapeXml(addr.city)}</city>\n`;
        if (addr.regioncode) xml += `          <regioncode>${escapeXml(addr.regioncode)}</regioncode>\n`;
        if (addr.postalcode) xml += `          <postalcode>${escapeXml(addr.postalcode)}</postalcode>\n`;
        xml += `        </address>\n`;
      }
      xml += `      </contact>\n`;
    }
    xml += `    </vendor>\n`;
  }

  // 5. Provider Section (Sending System)
  const p = prospect.provider;
  xml += `    <provider>\n`;
  xml += `      <name>${escapeXml(p.name)}</name>\n`;
  if (p.service) xml += `      <service>${escapeXml(p.service)}</service>\n`;
  if (p.url) xml += `      <url>${escapeXml(p.url)}</url>\n`;
  xml += `    </provider>\n`;

  // 6. Close
  xml += `  </prospect>\n`;
  xml += `</adf>`;

  return xml;
}
