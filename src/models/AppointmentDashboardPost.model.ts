import mongoose, { Document, Schema } from "mongoose";

export type AppointmentDashboardPostType =
  | "event"
  | "news"
  | "announcement"
  | "update";

export interface IAppointmentDashboardPost extends Document {
  organizationId: string;
  type: AppointmentDashboardPostType;
  title: string;
  content: string;
  createdBy: mongoose.Types.ObjectId;
  createdByModel: "User" | "CrmUser";
  authorName: string;
  authorRole: string;
  createdAt: Date;
  updatedAt: Date;
}

const AppointmentDashboardPostSchema = new Schema<IAppointmentDashboardPost>(
  {
    organizationId: {
      type: String,
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["event", "news", "announcement", "update"],
      default: "event",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      refPath: "createdByModel",
      required: true,
      index: true,
    },
    createdByModel: {
      type: String,
      required: true,
      enum: ["User", "CrmUser"],
      default: "CrmUser",
    },
    authorName: {
      type: String,
      required: true,
      trim: true,
    },
    authorRole: {
      type: String,
      required: true,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

AppointmentDashboardPostSchema.index({ organizationId: 1, createdAt: -1 });

const AppointmentDashboardPost = mongoose.model<IAppointmentDashboardPost>(
  "AppointmentDashboardPost",
  AppointmentDashboardPostSchema,
);

export default AppointmentDashboardPost;
