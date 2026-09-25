  import { randomUUID } from "crypto";
  import Load from "../models/Load.model";
  import User from "../models/User.model";
  import Notification from "../models/Notification.model";
  import DispatchChatMessage from "../models/DispatchChatMessage.model";
  import LoadReleaseRequest from "../models/LoadReleaseRequest.model";
  import notificationService from "./notification.service";
  import activityService from "./activity.service";
  import {
    ensureDispatchChatThread,
    touchDispatchChatThread,
    emitToDispatchChatThreadParticipants,
  } from "./dispatchChat.service";
  import { getSocketIO } from "../utils/socketEmitter";
  import logger from "../utils/logger";
  import mongoose from "mongoose";
  import {
    NonRetryableOutboxError,
    decideOutboxFailure,
  } from "./loadLifecycleOutboxPolicy";

  export type LoadLifecycleOutboxKind =
    | "load_sync"
    | "user_notification"
    | "org_admin_notification"
    | "activity"
    | "dispatch_chat_system"
    | "release_request_resolution";

  export type LoadLifecycleOutboxEvent = {
    eventId: string;
    kind: LoadLifecycleOutboxKind;
    payload: Record<string, any>;
    createdAt: Date;
    nextAttemptAt: Date;
    attempts: number;
  };

  const WORKER_INTERVAL_MS = 5_000;
  const EVENT_LOCK_MS = 30_000;
  const MAX_INLINE_EVENTS = 16;
  const PROCESSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const DEAD_LETTER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  // Outbox bookkeeping must not bump Load.updatedAt: lifecycle writes use
  // updatedAt as their optimistic-concurrency token.
  const NO_TIMESTAMPS = { timestamps: false } as const;
  const PENDING_EVENT_MATCH = {
    processedAt: { $exists: false },
    deadLetteredAt: { $exists: false },
  };
  let workerStarted = false;
  let workerRunning = false;
  let workerTimer: NodeJS.Timeout | null = null;
  let lastCleanupAt = 0;

  export function createLoadLifecycleOutboxEvent(
    kind: LoadLifecycleOutboxKind,
    payload: Record<string, any>,
  ): LoadLifecycleOutboxEvent {
    const now = new Date();
    return {
      eventId: randomUUID(),
      kind,
      payload,
      createdAt: now,
      nextAttemptAt: now,
      attempts: 0,
    };
  }

  export function appendLoadLifecycleOutbox(
    update: Record<string, any>,
    events: LoadLifecycleOutboxEvent[],
  ) {
    if (!events.length) return update;
    const next: Record<string, any> = { ...update };
    const existingPush = { ...(next.$push ?? {}) };

    if (existingPush.lifecycleOutbox) {
      throw new Error(
        "appendLoadLifecycleOutbox cannot merge an existing lifecycleOutbox push",
      );
    }

    existingPush.lifecycleOutbox = { $each: events };
    next.$push = existingPush;
    // Same atomic write as the events, so the worker index can never miss them.
    next.$set = { ...(next.$set ?? {}), lifecycleOutboxPending: true };
    return next;
  }

  async function notificationAlreadyDelivered(
    userId: string,
    eventId: string,
  ) {
    return Notification.exists({
      userId,
      "metadata.outboxEventId": eventId,
    });
  }

  async function deliverUserNotification(event: any) {
    const payload = event.payload ?? {};
    const userId = String(payload.userId ?? "");
    const organizationId = String(payload.organizationId ?? "");
    if (!userId || !organizationId) {
      throw new NonRetryableOutboxError("Outbox user_notification is missing recipient ownership");
    }

    if (await notificationAlreadyDelivered(userId, event.eventId)) return;

    await notificationService.createNotification({
      userId,
      organizationId,
      type: String(payload.type ?? "general"),
      title: String(payload.title ?? "Load Update"),
      message: String(payload.message ?? "Load updated"),
      metadata: {
        ...(payload.metadata ?? {}),
        outboxEventId: event.eventId,
      },
      dedupeKey: `load-lifecycle-outbox:${event.eventId}:${userId}`,
      groupWindowMinutes: 24 * 60,
    } as any);
  }

  async function deliverOrgAdminNotification(event: any) {
    const payload = event.payload ?? {};
    const organizationId = String(payload.organizationId ?? "");
    if (!organizationId) {
      throw new NonRetryableOutboxError("Outbox org_admin_notification is missing organizationId");
    }

    const excludeUserId = String(payload.excludeUserId ?? "");
    const admins: any[] = await User.find({
      organizationId,
      $or: [
        { role: { $in: ["admin", "super_admin"] } },
        { organizationRole: { $in: ["admin", "super_admin"] } },
      ],
      ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {}),
    })
      .select("_id")
      .lean();

    for (const admin of admins) {
      const userId = String(admin._id);
      if (await notificationAlreadyDelivered(userId, event.eventId)) continue;

      await notificationService.createNotification({
        userId,
        organizationId,
        type: String(payload.type ?? "general"),
        title: String(payload.title ?? "Load Update"),
        message: String(payload.message ?? "Load updated"),
        metadata: {
          ...(payload.metadata ?? {}),
          outboxEventId: event.eventId,
        },
        dedupeKey: `load-lifecycle-outbox:${event.eventId}:${userId}`,
        groupWindowMinutes: 24 * 60,
      } as any);
    }
  }

  async function deliverLoadSync(event: any) {
    const payload = event.payload ?? {};
    const organizationId = String(payload.organizationId ?? "");
    const loadId = String(payload.loadId ?? "");
    const driverIds = Array.isArray(payload.driverIds)
      ? payload.driverIds.map((value: any) => String(value ?? "")).filter(Boolean)
      : [];

    const io = getSocketIO();
    if (!io) return;

    if (organizationId) {
      io.to(`org:${organizationId}`).emit("load:change", {
        action: "updated",
        loadId,
      });
    }
    for (const driverId of driverIds) {
      io.to(`user:${driverId}`).emit("driver:loads_updated", { loadId });
    }
  }

  async function deliverActivity(event: any) {
    const payload = event.payload ?? {};
    const createActivity = (activityService as any).createActivity;
    if (typeof createActivity !== "function") {
      throw new NonRetryableOutboxError("activityService.createActivity is unavailable");
    }

    // UserActivity.userId is an ObjectId; a missing actor can never succeed.
    const userId = String(payload.userId ?? "");
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new NonRetryableOutboxError("Outbox activity is missing a valid actor userId");
    }

    await createActivity.call(activityService, {
      userId,
      organizationId: String(payload.organizationId ?? ""),
      type: String(payload.type ?? "load_updated"),
      title: String(payload.title ?? "Load Updated"),
      description: String(payload.description ?? "Load updated"),
      metadata: {
        ...(payload.metadata ?? {}),
        loadId: String(payload.loadId ?? payload.metadata?.loadId ?? ""),
        outboxEventId: event.eventId,
      },
    });
  }

  async function deliverDispatchChatSystem(event: any) {
    const payload = event.payload ?? {};
    const organizationId = String(payload.organizationId ?? "");
    const dispatcherId = String(payload.dispatcherId ?? "");
    const driverId = String(payload.driverId ?? "");
    if (!organizationId || !dispatcherId || !driverId) {
      throw new NonRetryableOutboxError("Outbox dispatch_chat_system is missing thread ownership");
    }

    const existing = await DispatchChatMessage.findOne({
      organizationId,
      dispatcherId,
      driverId,
      "systemEvent.metadata.outboxEventId": event.eventId,
    }).lean();
    if (existing) return;

    // dispatcherId is the OWNER of the private dispatcher↔driver thread. For
    // organization-support actions, performedByUserId may be a different staff
    // member who actually removed/reassigned the Load. Keeping these identities
    // separate lets the event land in the original dispatcher's conversation
    // while remaining truthful about who performed the action.
    const dispatcher: any = await User.findOne({
      _id: dispatcherId,
      role: { $in: ["employee", "admin", "super_admin"] },
    })
      .select("_id name email role isActive organizationId")
      .lean();
    if (!dispatcher) {
      throw new NonRetryableOutboxError("Outbox dispatcher is no longer available");
    }

    const requestedPerformerId = String(
      payload.performedByUserId ?? dispatcherId,
    ).trim() || dispatcherId;
    const requestedPerformerRole =
      payload.performedByRole === "driver"
        ? "driver"
        : "dispatcher";
    let performer: any = dispatcher;
    let senderRole: "driver" | "dispatcher" = "dispatcher";

    if (requestedPerformerRole === "driver") {
      if (requestedPerformerId !== driverId) {
        throw new NonRetryableOutboxError(
          "Driver-authored Dispatch Chat lifecycle event does not match the thread driver",
        );
      }

      const candidate: any = await User.findOne({
        _id: driverId,
        role: "driver",
        isActive: true,
      })
        .select("_id name email role isActive organizationId")
        .lean();

      if (!candidate) {
        throw new NonRetryableOutboxError(
          "Outbox driver performer is no longer available",
        );
      }

      performer = candidate;
      senderRole = "driver";
    } else if (requestedPerformerId !== dispatcherId) {
      const candidate: any = await User.findOne({
        _id: requestedPerformerId,
        role: { $in: ["employee", "admin", "super_admin"] },
      })
        .select("_id name email role isActive organizationId")
        .lean();

      // Existing Test-12 support-member behavior is deliberately preserved.
      if (
        candidate &&
        (candidate.role === "super_admin" ||
          String(candidate.organizationId ?? "") === organizationId)
      ) {
        performer = candidate;
      }
    }

    const performerId = String(performer._id);
    const performedByUserId = requestedPerformerId;
    const performedByName = String(
      payload.performedByName ?? performer.name ?? "Organization member",
    );
    const notifyThreadOwner = payload.notifyThreadOwner === true;

    const thread: any = await ensureDispatchChatThread({
      organizationId,
      dispatcherId,
      driverId,
    });

    // Existing lifecycle events preserve their prior read semantics. Test-14
    // events can explicitly name the participants who must see the system row as
    // unread. This is opt-in, so support-member/Test-12 behavior is unchanged.
    const explicitUnreadParticipantIds = new Set(
      Array.isArray(payload.metadata?.unreadForParticipantIds)
        ? payload.metadata.unreadForParticipantIds
            .map((value: any) => String(value ?? "").trim())
            .filter(Boolean)
        : [],
    );

    const readBy =
      explicitUnreadParticipantIds.size > 0
        ? [dispatcherId, driverId].filter(
            (participantId) =>
              !explicitUnreadParticipantIds.has(participantId),
          )
        : notifyThreadOwner
          ? performerId !== dispatcherId
            ? [performer._id]
            : []
          : [dispatcher._id];

    const message: any = await DispatchChatMessage.create({
      organizationId,
      threadId: thread._id,
      dispatcherId,
      driverId,
      senderId: performer._id,
      senderRole,
      messageType: "system",
      systemEvent: {
        type: String(payload.eventType ?? "driver_load_updated"),
        title: String(payload.title ?? "Load Updated"),
        message: String(payload.message ?? "Dispatch updated your load"),
        metadata: {
          ...(payload.metadata ?? {}),
          outboxEventId: event.eventId,
          sentByUserId: performedByUserId,
          sentByName: performedByName,
          threadDispatcherId: dispatcherId,
        },
      },
      content: String(payload.message ?? "Dispatch updated your load"),
      attachments: [],
      readBy,
    });

    const hidePerformerIdentityFromDriver = Boolean(
      payload.metadata?.hidePerformerIdentityFromDriver === true &&
        senderRole === "dispatcher",
    );
    const hideSelectedDriverIdentityFromDriver = Boolean(
      payload.metadata?.hideSelectedDriverIdentityFromDriver === true &&
        senderRole === "dispatcher",
    );
    const requiresDriverPrivacyPayload =
      hidePerformerIdentityFromDriver ||
      hideSelectedDriverIdentityFromDriver;
    const driverSafeMessage = String(
      payload.metadata?.audienceMessages?.driver ??
        payload.message ??
        "Dispatch updated your load",
    );

    // The thread preview is shared by both participants. When another same-org
    // dispatcher performs an action in the original dispatcher's private thread,
    // keep the preview driver-safe so the unrelated staff identity cannot leak
    // through the driver's conversation list.
    const sharedThreadPreview = String(
      payload.metadata?.threadPreview ??
        (requiresDriverPrivacyPayload
          ? driverSafeMessage
          : message.content),
    );

    await touchDispatchChatThread({
      threadId: thread._id,
      senderId: performer._id,
      messageType: "system",
      content: sharedThreadPreview,
      fallbackPreview: String(payload.title ?? "Load Updated"),
      at: message.createdAt,
    });

    const fullSocketPayload = {
      id: String(message._id),
      threadId: String(thread._id),
      dispatcherId,
      driverId,
      sender: {
        id: performerId,
        name: performer.name || performedByName || "Dispatcher",
        email: performer.email || "",
        role: performer.role,
      },
      senderRole,
      messageType: "system" as const,
      systemEvent: message.systemEvent,
      content: message.content,
      attachments: [],
      readBy: readBy.map((id: any) => String(id)),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };

    if (requiresDriverPrivacyPayload) {
      const safeMetadata = {
        ...(message.systemEvent?.metadata ?? {}),
      } as Record<string, any>;

      if (hidePerformerIdentityFromDriver) {
        for (const key of [
          "actorId",
          "actorName",
          "performedByUserId",
          "performedByName",
          "sentByUserId",
          "sentByName",
          "newDriverId",
          "newDriverName",
        ]) {
          delete safeMetadata[key];
        }
      }

      if (hideSelectedDriverIdentityFromDriver) {
        delete safeMetadata.selectedDriverId;
        delete safeMetadata.selectedDriverName;
      }

      safeMetadata.audienceMessages = {
        driver: driverSafeMessage,
      };
      safeMetadata.privacyRedacted = true;

      const driverSocketPayload = {
        ...fullSocketPayload,
        sender: hidePerformerIdentityFromDriver
          ? {
              id: "organization-dispatch",
              name: "Another dispatcher",
              email: "",
              role: "dispatcher",
            }
          : fullSocketPayload.sender,
        systemEvent: {
          ...(message.systemEvent ?? {}),
          message: driverSafeMessage,
          metadata: safeMetadata,
        },
        content: driverSafeMessage,
      };

      // Privacy-sensitive lifecycle rows need participant-specific payloads:
      // Dispatch keeps full operational context while the driver receives only
      // the identities that policy allows.
      const io = getSocketIO();
      if (io) {
        io.to(`user:${dispatcherId}`).emit(
          "dispatch-chat:message",
          fullSocketPayload,
        );
        io.to(`user:${driverId}`).emit(
          "dispatch-chat:message",
          driverSocketPayload,
        );
      }
    } else {
      emitToDispatchChatThreadParticipants(
        thread,
        "dispatch-chat:message",
        fullSocketPayload,
      );
    }
  }


  async function deliverReleaseRequestResolution(event: any) {
    const payload = event.payload ?? {};
    const organizationId = String(payload.organizationId ?? "");
    const loadId = String(payload.loadId ?? "");
    const driverId = String(payload.driverId ?? "");
    const requestId = String(payload.requestId ?? "");
    const targetStatus = String(payload.status ?? "");
    const decision = String(payload.decision ?? "");

    if (
      !organizationId ||
      !loadId ||
      !driverId ||
      !requestId ||
      !targetStatus ||
      !decision
    ) {
      throw new NonRetryableOutboxError(
        "Outbox release_request_resolution is missing required ownership or decision data",
      );
    }

    let request: any = await LoadReleaseRequest.findOne({
      _id: requestId,
      organizationId,
      loadId,
      driverId,
    });

    // The Load transition already committed with an exact snapshot of the
    // pending request. If a concurrent cleanup deleted that row, recreate the
    // audit record directly in its resolved state so the operational Load and
    // request history cannot remain permanently inconsistent.
    if (!request) {
      const snapshot = payload.requestSnapshot ?? {};
      try {
        request = await LoadReleaseRequest.create({
          _id: requestId,
          organizationId,
          loadId,
          driverId,
          dispatcherId: snapshot.dispatcherId || undefined,
          priority: snapshot.priority || "standard",
          reason: snapshot.reason || "other",
          message: snapshot.message || undefined,
          loadStatusAtRequest:
            snapshot.loadStatusAtRequest || "Assigned",
          status: targetStatus,
          decision,
          replacementDriverId:
            payload.replacementDriverId || undefined,
          requestedAt: snapshot.requestedAt
            ? new Date(snapshot.requestedAt)
            : new Date(event.createdAt ?? Date.now()),
          reviewedAt: payload.reviewedAt
            ? new Date(payload.reviewedAt)
            : new Date(),
          reviewedBy: payload.reviewedBy || undefined,
          lifecycleResolutionEventId: event.eventId,
          lifecycleResolvedAt: new Date(),
        });
        return;
      } catch (error: any) {
        // A concurrent retry/recreation can win the unique _id/event-id race.
        if (Number(error?.code) !== 11000) throw error;
        request = await LoadReleaseRequest.findOne({
          _id: requestId,
          organizationId,
          loadId,
          driverId,
        });
        if (!request) throw error;
      }
    }

    if (
      String(request.lifecycleResolutionEventId ?? "") ===
      String(event.eventId)
    ) {
      return;
    }

    const sameFinalOutcome =
      String(request.status ?? "") === targetStatus &&
      String(request.decision ?? "") === decision &&
      String(request.replacementDriverId ?? "") ===
        String(payload.replacementDriverId ?? "");

    const set: Record<string, any> = {
      status: targetStatus,
      decision,
      reviewedAt: payload.reviewedAt
        ? new Date(payload.reviewedAt)
        : new Date(),
      lifecycleResolutionEventId: event.eventId,
      lifecycleResolvedAt: new Date(),
    };

    if (payload.reviewedBy) set.reviewedBy = payload.reviewedBy;
    if (payload.replacementDriverId) {
      set.replacementDriverId = payload.replacementDriverId;
    }

    // If another reviewer decision raced with the actual Load transition, the
    // committed Load outcome is canonical. Preserve the previous decision here
    // before reconciling the request so the race remains auditable.
    if (
      !sameFinalOutcome &&
      String(request.status ?? "") !== "pending"
    ) {
      set.supersededStatus = request.status;
      if (request.decision) {
        set.supersededDecision = request.decision;
      }
      if (request.decisionReason) {
        set.supersededDecisionReason = request.decisionReason;
      }
    }

    const unset: Record<string, ""> = {};
    if (!payload.replacementDriverId) {
      unset.replacementDriverId = "";
    }
    // A stale rejection explanation must not look like the explanation for the
    // final approved/cancelled Load outcome. Preserve it above when applicable.
    if (request.decisionReason && !payload.decisionReason) {
      unset.decisionReason = "";
    } else if (payload.decisionReason) {
      set.decisionReason = String(payload.decisionReason).slice(0, 1000);
    }

    await LoadReleaseRequest.updateOne(
      {
        _id: request._id,
        lifecycleResolutionEventId: { $ne: event.eventId },
      },
      {
        $set: set,
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
    );
  }

  async function deliverEvent(event: any) {
    switch (event.kind as LoadLifecycleOutboxKind) {
      case "load_sync":
        return deliverLoadSync(event);
      case "user_notification":
        return deliverUserNotification(event);
      case "org_admin_notification":
        return deliverOrgAdminNotification(event);
      case "activity":
        return deliverActivity(event);
      case "dispatch_chat_system":
        return deliverDispatchChatSystem(event);
      case "release_request_resolution":
        return deliverReleaseRequestResolution(event);
      default:
        throw new NonRetryableOutboxError(`Unsupported Load lifecycle outbox kind: ${event.kind}`);
    }
  }

  async function claimNextEvent(loadId?: string) {
    const now = new Date();
    const lockToken = randomUUID();
    const lockedUntil = new Date(now.getTime() + EVENT_LOCK_MS);

    const eventMatch: Record<string, any> = {
      ...PENDING_EVENT_MATCH,
      nextAttemptAt: { $lte: now },
      $or: [
        { lockedUntil: { $exists: false } },
        { lockedUntil: null },
        { lockedUntil: { $lte: now } },
      ],
    };

    const load: any = await Load.findOneAndUpdate(
      {
        // The inline flush targets one known Load. The background worker only
        // looks at Loads flagged as pending, which is served by a partial index.
        ...(loadId ? { _id: loadId } : { lifecycleOutboxPending: true }),
        lifecycleOutbox: { $elemMatch: eventMatch },
      },
      {
        $set: {
          "lifecycleOutbox.$.lockToken": lockToken,
          "lifecycleOutbox.$.lockedUntil": lockedUntil,
        },
        $inc: { "lifecycleOutbox.$.attempts": 1 },
      },
      { new: true, ...NO_TIMESTAMPS },
    ).select("+lifecycleOutbox");

    if (!load) return null;
    const event = Array.isArray(load.lifecycleOutbox)
      ? load.lifecycleOutbox.find(
          (entry: any) => String(entry?.lockToken ?? "") === lockToken,
        )
      : null;
    if (!event) return null;

    return { loadId: String(load._id), event, lockToken };
  }

  /**
   * Clear the pending flag once no deliverable event remains. The filter is
   * evaluated atomically, and appendLoadLifecycleOutbox sets the flag in the
   * same write that adds events, so a concurrent append can never be missed.
   */
  async function clearPendingFlagIfDrained(loadId: string) {
    await Load.updateOne(
      {
        _id: loadId,
        lifecycleOutboxPending: true,
        lifecycleOutbox: { $not: { $elemMatch: PENDING_EVENT_MATCH } },
      },
      { $unset: { lifecycleOutboxPending: "" } },
      NO_TIMESTAMPS,
    );
  }

  async function markProcessed(
    loadId: string,
    eventId: string,
    lockToken: string,
  ) {
    await Load.updateOne(
      { _id: loadId },
      {
        $set: {
          "lifecycleOutbox.$[event].processedAt": new Date(),
        },
        $unset: {
          "lifecycleOutbox.$[event].lockToken": "",
          "lifecycleOutbox.$[event].lockedUntil": "",
          "lifecycleOutbox.$[event].lastError": "",
        },
      },
      {
        ...NO_TIMESTAMPS,
        arrayFilters: [
          {
            "event.eventId": eventId,
            "event.lockToken": lockToken,
          },
        ],
      },
    );
    await clearPendingFlagIfDrained(loadId);
  }

  async function markFailed(
    loadId: string,
    event: any,
    lockToken: string,
    error: unknown,
  ) {
    const attempts = Number(event.attempts ?? 1);
    const decision = decideOutboxFailure(error, attempts);
    const message = (
      error instanceof Error ? error.message : String(error ?? "unknown error")
    ).slice(0, 1200);
    const logContext = {
      loadId,
      eventId: String(event?.eventId ?? ""),
      kind: String(event?.kind ?? ""),
      attempts,
      error: message,
    };

    if (decision.action === "dead_letter") {
      // Never logs the payload: it can contain recipients and message text.
      logger.error(
        { ...logContext, reason: decision.reason },
        "Load lifecycle outbox event dead-lettered; it will not be retried",
      );
    } else {
      logger.warn(
        { ...logContext, retryInMs: decision.delayMs },
        "Load lifecycle outbox event delivery failed; retry scheduled",
      );
    }

    const set: Record<string, unknown> = {
      "lifecycleOutbox.$[event].lastError": message,
    };
    if (decision.action === "dead_letter") {
      set["lifecycleOutbox.$[event].deadLetteredAt"] = new Date();
    } else {
      set["lifecycleOutbox.$[event].nextAttemptAt"] = new Date(
        Date.now() + decision.delayMs,
      );
    }

    await Load.updateOne(
      { _id: loadId },
      {
        $set: set,
        $unset: {
          "lifecycleOutbox.$[event].lockToken": "",
          "lifecycleOutbox.$[event].lockedUntil": "",
        },
      },
      {
        ...NO_TIMESTAMPS,
        arrayFilters: [
          {
            "event.eventId": String(event.eventId),
            "event.lockToken": lockToken,
          },
        ],
      },
    );

    if (decision.action === "dead_letter") {
      await clearPendingFlagIfDrained(loadId);
    }
  }

  async function processClaim(claim: any) {
    try {
      await deliverEvent(claim.event);
    } catch (error) {
      await markFailed(claim.loadId, claim.event, claim.lockToken, error);
      return;
    }
    await markProcessed(
      claim.loadId,
      String(claim.event.eventId),
      claim.lockToken,
    );
  }

  export async function processLoadLifecycleOutboxForLoad(loadId: string) {
    for (let index = 0; index < MAX_INLINE_EVENTS; index += 1) {
      const claim = await claimNextEvent(loadId);
      if (!claim) break;
      await processClaim(claim);
    }
  }

  /**
   * Safety net for events written without the pending flag: rows queued before
   * this flag existed, or a flag cleared by an unexpected race. This is the
   * only unindexed outbox query, and it runs at startup and then hourly.
   */
  async function reflagOrphanedPendingEvents() {
    const result = await Load.updateMany(
      {
        lifecycleOutboxPending: { $ne: true },
        lifecycleOutbox: { $elemMatch: PENDING_EVENT_MATCH },
      },
      { $set: { lifecycleOutboxPending: true } },
      NO_TIMESTAMPS,
    );
    if (result.modifiedCount > 0) {
      logger.warn(
        { count: result.modifiedCount },
        "Re-flagged Loads with undelivered lifecycle outbox events",
      );
    }
  }

  async function cleanupProcessedEvents() {
    const processedCutoff = new Date(Date.now() - PROCESSED_RETENTION_MS);
    const deadLetterCutoff = new Date(Date.now() - DEAD_LETTER_RETENTION_MS);
    await Load.updateMany(
      {
        $or: [
          { "lifecycleOutbox.processedAt": { $lte: processedCutoff } },
          { "lifecycleOutbox.deadLetteredAt": { $lte: deadLetterCutoff } },
        ],
      },
      {
        $pull: {
          lifecycleOutbox: {
            $or: [
              { processedAt: { $lte: processedCutoff } },
              { deadLetteredAt: { $lte: deadLetterCutoff } },
            ],
          },
        },
      },
      NO_TIMESTAMPS,
    );
  }

  async function runWorkerCycle() {
    if (workerRunning) return;
    workerRunning = true;
    try {
      for (let index = 0; index < 40; index += 1) {
        const claim = await claimNextEvent();
        if (!claim) break;
        await processClaim(claim);
      }

      if (Date.now() - lastCleanupAt > 60 * 60_000) {
        lastCleanupAt = Date.now();
        await cleanupProcessedEvents();
        await reflagOrphanedPendingEvents();
      }
    } catch (error) {
      logger.error({ error }, "Load lifecycle outbox worker cycle failed");
    } finally {
      workerRunning = false;
    }
  }

  export function startLoadLifecycleOutboxWorker() {
    if (workerStarted) return;
    workerStarted = true;

    // lastCleanupAt starts at 0, so the first cycle runs cleanup and re-flag.
    // Events queued before this deploy are picked up without a migration.
    void runWorkerCycle();
    workerTimer = setInterval(() => {
      void runWorkerCycle();
    }, WORKER_INTERVAL_MS);
    workerTimer.unref?.();

    logger.info("Load lifecycle durable outbox worker started");
  }
