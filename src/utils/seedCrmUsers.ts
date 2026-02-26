import CrmUser from '../models/CrmUser.model';

const CRM_USERS = [
  { fullName: 'Jason Berry', username: '2026-00001', email: 'jason@actionautoutah.com', role: 'admin' as const },
  { fullName: 'Erik Schofield', username: '2026-00002', email: 'erik@actionautoutah.com', role: 'admin' as const },
  { fullName: 'Candice Saligumba', username: '2026-00003', email: 'candice@actionautoutah.com', role: 'admin' as const },
  { fullName: 'RJ Turingan', username: '2026-00004', email: 'roque@actionautoutah.com', role: 'admin' as const },
  { fullName: 'Alexandra Marie SAA', username: '2026-00005', email: 'alexandra@actionautoutah.com', role: 'admin' as const },
  { fullName: 'John Belen', username: '2026-00006', email: 'john2@actionautoutah.com', role: 'admin' as const },
  { fullName: 'Kim Vega', username: '2026-00007', email: 'kim@actionautoutah.com', role: 'admin' as const },
  { fullName: 'Mikka Catumber', username: '2026-00008', email: 'mikka@actionautoutah.com', role: 'admin' as const },
  { fullName: 'Charl Narvaez', username: '2026-00009', email: 'charl@actionautoutah.com', role: 'admin' as const },
  { fullName: 'Romuel Lopez', username: '2026-00010', email: 'romuel@actionautoutah.com', role: 'admin' as const },
  { fullName: 'Czerina Duro', username: '2026-00011', email: 'czerina@actionautoutah.com', role: 'admin' as const },
  { fullName: 'Jenelyn Martinez', username: '2026-00012', email: 'jenelyn@actionautoutah.com', role: 'admin' as const },
  { fullName: 'Krizza Pepito', username: '2026-00013', email: 'krizza@actionautoutah.com', role: 'admin' as const },
];

const DEFAULT_PASSWORD = 'superadmin@123!';

/**
 * Auto-seed CRM users on server startup.
 * Call this AFTER mongoose.connect() in your server entry file.
 * Safe to run multiple times — skips users that already exist.
 */
const seedCrmUsers = async (): Promise<void> => {
  try {
    console.log('[CRM Seed] Checking CRM users...');

    let created = 0;
    let existing = 0;

    for (const userData of CRM_USERS) {
      const exists = await CrmUser.findOne({
        $or: [{ username: userData.username }, { email: userData.email }],
      });

      if (exists) {
        existing++;
        continue;
      }

      // Password is auto-hashed by the pre-save hook in CrmUser model
      await CrmUser.create({
        ...userData,
        password: DEFAULT_PASSWORD,
        isActive: true,
      });

      created++;
    }

    if (created > 0) {
      console.log(`[CRM Seed] Created ${created} new CRM users`);
    }

    if (existing > 0) {
      console.log(`[CRM Seed] ⏭  ${existing} CRM users already exist`);
    }

    const total = await CrmUser.countDocuments();
    console.log(`[CRM Seed] Total CRM users in database: ${total}`);
  } catch (error) {
    console.error('[CRM Seed] Failed to seed CRM users:', error);
    // Don't throw — server should still start even if seed fails
  }
};

export default seedCrmUsers;