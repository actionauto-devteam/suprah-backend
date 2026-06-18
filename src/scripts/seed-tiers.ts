import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '../../.env') });

import MembershipTier from '../models/MembershipTier.model';

const TIERS = [
  {
    name: 'Ignition',
    slug: 'ignition',
    rank: 1,
    minPoints: 0,
    discountPercent: 0,
    benefits: [
      'Full customer portal access',
      'Member QR identity card',
      'Service & test-drive booking',
      'Garage vehicle management',
    ],
    colorTheme: { primary: '#9ca3af', secondary: '#4b5563', gradient: ['#374151', '#9ca3af'] },
    isActive: true,
  },
  {
    name: 'Cruiser',
    slug: 'cruiser',
    rank: 2,
    minPoints: 300,
    discountPercent: 2,
    benefits: [
      '2% member pricing on vehicles & parts',
      'Priority support queue',
      'All Ignition benefits',
    ],
    colorTheme: { primary: '#38bdf8', secondary: '#0369a1', gradient: ['#0c4a6e', '#38bdf8'] },
    isActive: true,
  },
  {
    name: 'Sport',
    slug: 'sport',
    rank: 3,
    minPoints: 1000,
    discountPercent: 4,
    benefits: [
      '4% member pricing on vehicles & parts',
      'Early access to new inventory',
      'Free aftermarket shipping',
      'All Cruiser benefits',
    ],
    colorTheme: { primary: '#34d399', secondary: '#047857', gradient: ['#064e3b', '#34d399'] },
    isActive: true,
  },
  {
    name: 'Turbo',
    slug: 'turbo',
    rank: 4,
    minPoints: 2500,
    discountPercent: 6,
    benefits: [
      '6% member pricing on vehicles & parts',
      'Priority service appointment slots',
      'Dedicated support badge',
      'All Sport benefits',
    ],
    colorTheme: { primary: '#fbbf24', secondary: '#b45309', gradient: ['#78350f', '#fbbf24'] },
    isActive: true,
  },
  {
    name: 'Supercharged',
    slug: 'supercharged',
    rank: 5,
    minPoints: 6000,
    discountPercent: 8,
    benefits: [
      '8% member pricing on vehicles & parts',
      'VIP test-drive scheduling',
      'Exclusive deals access',
      'All Turbo benefits',
    ],
    colorTheme: { primary: '#fb923c', secondary: '#c2410c', gradient: ['#7c2d12', '#fb923c'] },
    isActive: true,
  },
  {
    name: 'Apex',
    slug: 'apex',
    rank: 6,
    minPoints: 12000,
    discountPercent: 10,
    benefits: [
      '10% member pricing on vehicles & parts',
      'Free annual vehicle inspection credit',
      'Priority financing review',
      'All Supercharged benefits',
    ],
    colorTheme: { primary: '#f43f5e', secondary: '#9f1239', gradient: ['#4c0519', '#f43f5e'] },
    isActive: true,
  },
  {
    name: 'Hypercar',
    slug: 'hypercar',
    rank: 7,
    minPoints: 25000,
    discountPercent: 12,
    benefits: [
      '12% member pricing on vehicles & parts',
      'Personal concierge line',
      'Exclusive auction access',
      'All Apex benefits',
    ],
    colorTheme: { primary: '#a855f7', secondary: '#dc2626', gradient: ['#7c3aed', '#db2777', '#f59e0b'] },
    isActive: true,
  },
];

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI as string);
  console.log('Connected to MongoDB');

  await MembershipTier.deleteMany({});
  const inserted = await MembershipTier.insertMany(TIERS);
  console.log(`Seeded tiers: ${inserted.length} tiers (table reset)`);

  await mongoose.disconnect();
  console.log('Done');
}

seed().catch(err => { console.error(err); process.exit(1); });
