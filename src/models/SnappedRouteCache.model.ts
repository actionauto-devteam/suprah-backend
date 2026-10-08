import mongoose, { Document, Model, Schema } from "mongoose";

/*
 * Road-snapped route pieces from Amazon Location Service, saved so the same
 * stretch of GPS readings is only sent (and paid for) once. Keyed by a hash of
 * the readings; removed automatically after 30 days, like trip history.
 */

export interface ISnappedRouteCache extends Document {
  key: string;
  /** [longitude, latitude] pairs along the roads. */
  line: number[][];
  createdAt: Date;
}

const snappedRouteCacheSchema = new Schema<ISnappedRouteCache>({
  key: { type: String, required: true },
  line: { type: [[Number]], required: true },
  createdAt: { type: Date, required: true, default: Date.now },
});

snappedRouteCacheSchema.index({ key: 1 }, { unique: true });
snappedRouteCacheSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

const SnappedRouteCache: Model<ISnappedRouteCache> =
  (mongoose.models.SnappedRouteCache as Model<ISnappedRouteCache>) ||
  mongoose.model<ISnappedRouteCache>("SnappedRouteCache", snappedRouteCacheSchema);

export default SnappedRouteCache;
