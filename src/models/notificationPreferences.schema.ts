import { Schema } from 'mongoose';
import { NOTIFICATION_CATEGORIES, NotificationCategory } from './Notification.model';

// Category-level toggles (the original, coarse mechanism) plus mutedTypes —
// a finer, per-notification-type mute list layered on top, so e.g. the `crm`
// category can stay enabled while a specific noisy type within it (SupraSpace
// messages, `crm_message`) is individually silenced. See TYPE_CATEGORY_MAP in
// notification.service.ts for which types belong to which category, and
// CRM_TYPE_GROUPS (frontend, notification-preference-categories.tsx) for the
// UI grouping of CRM's types specifically.
export type NotificationPreferences = Record<NotificationCategory, boolean> & {
  mutedTypes: string[];
  // CrmUser ids whose messages always notify this user, even in a
  // conversation (group or DM) they've muted/set to none/foryou, and even
  // with the "Messages" category off — see pushToConversationMembers and
  // notifyMentionedMembers in supraspace.controller.ts for the bypass.
  prioritySenders: string[];
};

const defaultNotificationPreferences: NotificationPreferences = {
  ...NOTIFICATION_CATEGORIES.reduce(
    (acc, category) => {
      acc[category] = true;
      return acc;
    },
    {} as Record<NotificationCategory, boolean>
  ),
  mutedTypes: [],
  prioritySenders: [],
};

export { defaultNotificationPreferences };

export const notificationPreferencesSchemaDefinition = {
  ...NOTIFICATION_CATEGORIES.reduce(
    (acc, category) => {
      acc[category] = { type: Boolean, default: true };
      return acc;
    },
    {} as Record<NotificationCategory, { type: BooleanConstructor; default: boolean }>
  ),
  mutedTypes: { type: [String], default: [] },
  prioritySenders: { type: [String], default: [] },
};

export const notificationPreferencesSchema = new Schema(notificationPreferencesSchemaDefinition, { _id: false });
