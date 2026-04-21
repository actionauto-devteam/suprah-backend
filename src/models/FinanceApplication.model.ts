import mongoose, { Schema, Document } from 'mongoose';
import { encrypt, decrypt } from '../utils/crypto';

export interface IFinanceApplication extends Document {
  organizationId: mongoose.Types.ObjectId;
  customerId: mongoose.Types.ObjectId;
  vehicleId: mongoose.Types.ObjectId;

  // Personal Info (Encrypted)
  personalInfo: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    dob: string;
    ssn: string; // Encrypted
    address: {
      street: string;
      city: string;
      state: string;
      zip: string;
    };
  };

  // Employment & Income (Encrypted)
  employmentInfo: {
    employer: string;
    jobTitle: string;
    income: string; // Encrypted
    incomeFrequency: 'Yearly' | 'Monthly' | 'Weekly';
    yearsAtJob: string;
  };

  // Metadata
  status: 'New' | 'Reviewing' | 'Approved' | 'Rejected' | 'Withdrawn';
  notes?: string;
  appliedAt: Date;
  updatedAt: Date;

  // Helpers
  getDecryptedSsn(): string;
  getDecryptedIncome(): string;
}

const FinanceApplicationSchema: Schema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
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
      ssn: { type: String, required: true }, // Store encrypted
      address: {
        street: String,
        city: String,
        state: String,
        zip: String,
      },
    },
    employmentInfo: {
      employer: String,
      jobTitle: String,
      income: String, // Store encrypted
      incomeFrequency: {
        type: String,
        enum: ['Yearly', 'Monthly', 'Weekly'],
        default: 'Yearly',
      },
      yearsAtJob: String,
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

// Pre-save hook to ensure fields are encrypted if they are modified
FinanceApplicationSchema.pre('save', function (next) {
  const doc = this as any;
  
  if (doc.isModified('personalInfo.ssn')) {
    try {
      // Only encrypt if it's not already in the 'iv:authTag:content' format
      if (!doc.personalInfo.ssn.includes(':')) {
        doc.personalInfo.ssn = encrypt(doc.personalInfo.ssn);
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

// Methods for decryption
FinanceApplicationSchema.methods.getDecryptedSsn = function () {
  return decrypt(this.personalInfo.ssn);
};

FinanceApplicationSchema.methods.getDecryptedIncome = function () {
  return decrypt(this.employmentInfo.income);
};

// Compound index for staff to find apps by org and date
FinanceApplicationSchema.index({ organizationId: 1, appliedAt: -1 });

export default mongoose.model<IFinanceApplication>('FinanceApplication', FinanceApplicationSchema);
