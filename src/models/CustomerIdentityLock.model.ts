import mongoose, { Schema } from 'mongoose';
import { IDENTITY_SCHEMA_OPTIONS } from '../constants/customerIdentityIndexes';

const schema = new Schema({
  organizationId: { type: String, required: true, unique: true },
  owner: { type: String, required: true },
  expiresAt: { type: Date, required: true },
}, IDENTITY_SCHEMA_OPTIONS);

export default mongoose.model('CustomerIdentityLock', schema);
