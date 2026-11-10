import mongoose, { Schema, Document } from 'mongoose';
import { encrypt, decrypt } from '../utils/crypto';

export interface IFinanceApplication extends Document {
  organizationId: mongoose.Types.ObjectId;
  /** The applicant's customer account; empty when staff filled it in for someone without one. */
  customerId?: mongoose.Types.ObjectId;
  /** The staff member who filled it in for the customer, if any. */
  submittedBy?: mongoose.Types.ObjectId;
  vehicleId: mongoose.Types.ObjectId;

  personalInfo: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    dob: string;
    ssn: string;
    address: {
      street: string;
      city: string;
      state: string;
      zip: string;
    };
    applicationType?: 'individual' | 'joint';
    maritalStatus?: 'single' | 'married' | 'divorced' | 'widowed';
    /** Encrypted like the SSN. */
    driversLicenseNumber?: string;
  };

  employmentInfo: {
    employer: string;
    jobTitle: string;
    income: string;
    incomeFrequency: 'Yearly' | 'Monthly' | 'Weekly';
    yearsAtJob: string;
    workPhone?: string;
    payFrequency?: 'annually' | 'monthly' | 'bi-weekly' | 'weekly';
  };

  residence?: {
    housingStatus?: 'own' | 'rent' | 'other';
    monthlyPayment?: number;
    yearsAtAddress?: number;
    monthsAtAddress?: number;
  };
  reference?: { name?: string; relationship?: string; phone?: string };
  tradeIn?: { hasTradeIn: boolean; year?: string; make?: string; model?: string; mileage?: string };

  status: 'New' | 'Reviewing' | 'Approved' | 'Rejected' | 'Withdrawn';
  notes?: string;
  appliedAt: Date;
  updatedAt: Date;

  getDecryptedSsn(): string;
  getDecryptedIncome(): string;
  getDecryptedLicenseNumber(): string;
}

const FinanceApplicationSchema: Schema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    // Staff can fill it in for a customer with no account yet (2026-11-10).
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    submittedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    vehicleId: {
      type: Schema.Types.ObjectId,
      ref: 'Vehicle',
      required: true,
      index: true,
    },
    personalInfo: {
      firstName: { type: String, required: true },
      lastName: { type: String, required: true },
      email: { type: String, required: true },
      phone: { type: String, required: true },
      dob: { type: String, required: true },
      ssn: { type: String, required: true },
      address: {
        street: String,
        city: String,
        state: String,
        zip: String,
      },
      applicationType: { type: String, enum: ['individual', 'joint'] },
      maritalStatus: { type: String, enum: ['single', 'married', 'divorced', 'widowed'] },
      driversLicenseNumber: String,
    },
    employmentInfo: {
      employer: String,
      jobTitle: String,
      income: String,
      incomeFrequency: {
        type: String,
        enum: ['Yearly', 'Monthly', 'Weekly'],
        default: 'Yearly',
      },
      yearsAtJob: String,
      workPhone: String,
      payFrequency: { type: String, enum: ['annually', 'monthly', 'bi-weekly', 'weekly'] },
    },
    residence: {
      housingStatus: { type: String, enum: ['own', 'rent', 'other'] },
      monthlyPayment: Number,
      yearsAtAddress: Number,
      monthsAtAddress: Number,
    },
    reference: {
      name: String,
      relationship: String,
      phone: String,
    },
    tradeIn: {
      hasTradeIn: Boolean,
      year: String,
      make: String,
      model: String,
      mileage: String,
    },
    status: {
      type: String,
      enum: ['New', 'Reviewing', 'Approved', 'Rejected', 'Withdrawn'],
      default: 'New',
      index: true,
    },
    notes: String,
    appliedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

FinanceApplicationSchema.pre('save', function (next) {
  const doc = this as any;
  
  if (doc.isModified('personalInfo.ssn')) {
    try {
      if (!doc.personalInfo.ssn.includes(':')) {
        doc.personalInfo.ssn = encrypt(doc.personalInfo.ssn);
      }
    } catch (err) {
      return next(err as any);
    }
  }

  // The driver's license number is encrypted like the SSN (2026-11-10).
  if (doc.personalInfo?.driversLicenseNumber && doc.isModified('personalInfo.driversLicenseNumber')) {
    try {
      if (!doc.personalInfo.driversLicenseNumber.includes(':')) {
        doc.personalInfo.driversLicenseNumber = encrypt(doc.personalInfo.driversLicenseNumber);
      }
    } catch (err) {
      return next(err as any);
    }
  }

  if (doc.isModified('employmentInfo.income')) {
    try {
      if (!doc.employmentInfo.income.includes(':')) {
        doc.employmentInfo.income = encrypt(doc.employmentInfo.income);
      }
    } catch (err) {
      return next(err as any);
    }
  }

  next();
});

FinanceApplicationSchema.methods.getDecryptedSsn = function () {
  return decrypt(this.personalInfo.ssn);
};

FinanceApplicationSchema.methods.getDecryptedIncome = function () {
  return decrypt(this.employmentInfo.income);
};

FinanceApplicationSchema.methods.getDecryptedLicenseNumber = function () {
  return this.personalInfo?.driversLicenseNumber ? decrypt(this.personalInfo.driversLicenseNumber) : '';
};

FinanceApplicationSchema.index({ organizationId: 1, appliedAt: -1 });

export default mongoose.model<IFinanceApplication>('FinanceApplication', FinanceApplicationSchema);
