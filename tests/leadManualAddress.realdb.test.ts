import request from 'supertest';
import app from '../src/server';
import Lead from '../src/models/lead.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import tokenService from '../src/services/token.service';

describe('Lead name and address entry (license scanner save paths)', () => {
    let org: any;
    let otherOrg: any;
    let user: any;
    let token: string;
    const stamp = Date.now();

    beforeAll(async () => {
        org = await Organization.create({ name: 'Scanner Address Org', slug: `scan-addr-${stamp}`, status: 'active' });
        otherOrg = await Organization.create({ name: 'Scanner Other Org', slug: `scan-other-${stamp}`, status: 'active' });
        user = await User.create({
            email: `scan-addr-${stamp}@example.com`,
            password: 'Password123!',
            name: 'Scanner Tester',
            role: 'admin',
            organizationId: org._id,
            organizationRole: 'admin',
            emailVerified: true,
            onboardingCompleted: true,
            isActive: true,
        });
        token = tokenService.generateAccessToken(user);
    });

    afterAll(async () => {
        await Lead.deleteMany({ organizationId: { $in: [org._id, otherOrg._id] } });
        await User.deleteOne({ _id: user._id });
        await Organization.deleteMany({ _id: { $in: [org._id, otherOrg._id] } });
    });

    it('saves a confirmed address when a lead is added', async () => {
        const res = await request(app)
            .post('/api/leads')
            .set('Authorization', `Bearer ${token}`)
            .send({ firstName: 'Jordan', lastName: 'Sample', email: `jordan-${stamp}@example.com`, address: '  123 Main St, Apt 4, Salt Lake City, UT 84101  ' })
            .expect(201);
        const saved = await Lead.findById(res.body.data._id).lean();
        expect(saved?.address).toBe('123 Main St, Apt 4, Salt Lake City, UT 84101');
        expect(saved?.firstName).toBe('Jordan');
    });

    it('keeps the address empty when none is sent', async () => {
        const res = await request(app)
            .post('/api/leads')
            .set('Authorization', `Bearer ${token}`)
            .send({ firstName: 'Casey', email: `casey-${stamp}@example.com` })
            .expect(201);
        const saved = await Lead.findById(res.body.data._id).lean();
        expect(saved?.address).toBe('');
    });

    it('never stores license-only data even if a client sends it', async () => {
        const res = await request(app)
            .post('/api/leads')
            .set('Authorization', `Bearer ${token}`)
            .send({
                firstName: 'Taylor',
                email: `taylor-${stamp}@example.com`,
                address: '9 Elm St, UT',
                licenseNumber: 'S9876543',
                dateOfBirth: '01151990',
                rawBarcode: '@ANSI 636014DAQS9876543',
                licenseImage: 'data:image/png;base64,AAAA',
            })
            .expect(201);
        const saved = await Lead.findById(res.body.data._id).lean();
        const text = JSON.stringify(saved);
        expect(text).not.toMatch(/S9876543|01151990|ANSI|base64|licenseNumber|dateOfBirth|rawBarcode|licenseImage/);
        expect(saved?.address).toBe('9 Elm St, UT');
    });

    it('updates only the confirmed fields through the existing details endpoint', async () => {
        const lead = await Lead.create({
            organizationId: org._id,
            createdBy: user._id,
            firstName: 'Morgan',
            lastName: 'Tester',
            email: `morgan-${stamp}@example.com`,
            address: '12 Old Rd, Orem, UT 84057',
            channel: 'email',
            source: 'Manual Entry',
        });
        await request(app)
            .patch(`/api/leads/${lead._id}/details`)
            .set('Authorization', `Bearer ${token}`)
            .send({ address: '456 Oak Ave, Orem, UT 84057', licenseNumber: 'T1234098', dateOfBirth: '07041985' })
            .expect(200);
        const saved = await Lead.findById(lead._id).lean();
        expect(saved?.address).toBe('456 Oak Ave, Orem, UT 84057');
        expect(saved?.firstName).toBe('Morgan');
        expect(saved?.lastName).toBe('Tester');
        expect(JSON.stringify(saved)).not.toMatch(/T1234098|07041985|licenseNumber|dateOfBirth/);
    });

    it('refuses to update a lead from another dealership', async () => {
        const foreign = await Lead.create({
            organizationId: otherOrg._id,
            createdBy: user._id,
            firstName: 'Other',
            email: `other-${stamp}@example.com`,
            address: 'Other dealer address',
            channel: 'email',
            source: 'Manual Entry',
        });
        await request(app)
            .patch(`/api/leads/${foreign._id}/details`)
            .set('Authorization', `Bearer ${token}`)
            .send({ firstName: 'Changed', address: '1 Wrong St' })
            .expect(404);
        const saved = await Lead.findById(foreign._id).lean();
        expect(saved?.firstName).toBe('Other');
        expect(saved?.address).toBe('Other dealer address');
    });

    it('requires authentication to save scanned details', async () => {
        await request(app).post('/api/leads').send({ firstName: 'Nobody', email: `nobody-${stamp}@example.com`, address: 'x' }).expect(401);
        const count = await Lead.countDocuments({ email: `nobody-${stamp}@example.com` });
        expect(count).toBe(0);
    });
});
