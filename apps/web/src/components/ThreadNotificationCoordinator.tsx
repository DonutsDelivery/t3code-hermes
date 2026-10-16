import {
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { pendingSubagentRequestsByThread } from "@t3tools/client-runtime/state/threads";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  isHermesTasksAnnouncedTurn,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { environmentShell } from "../state/shell";
import {
  ATTENTION_SEVERITY,
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  unlockNotificationAudio,
  type AttentionKind,
} from "../threadNotifications";
import { HermesCronWatcher } from "./hermes/HermesCronWatcher";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { toastManager } from "./ui/toast";

export function ThreadNotificationCoordinator() {
  const environmentIds = useEnvironmentIds();
  const mode = useClientSettings((settings) => settings.notificationMode);
  // Unseen background alerts, badged whether or not the OS notification was allowed.
  const pending = useRef(new Map<string, PendingAttention>());
  const statusDots = useClientSettings((settings) => settings.tabStatusDots);
  const statusDotsRef = useRef(statusDots);
  const syncBadge = useCallback((blink = false) => {
    if (!statusDotsRef.current) {
      setNotificationBadge(pending.current.size);
      return;
    }
    let kind: AttentionKind = "completion";
    for (const entry of pending.current.values()) {
      if (ATTENTION_SEVERITY[entry.kind] > ATTENTION_SEVERITY[kind]) kind = entry.kind;
    }
    setNotificationBadge(pending.current.size, { kind, blink });
  }, []);
  // Flipping the setting redraws any badge already showing, without a blink.
  useEffect(() => {
    if (statusDotsRef.current === statusDots) return;
    statusDotsRef.current = statusDots;
    if (pending.current.size > 0) syncBadge();
  }, [statusDots, syncBadge]);
  const onAttention = useCallback<OnAttention>(
    (environmentId, tag, kind, notification) => {
      pending.current.get(tag)?.notification?.close();
      pending.current.set(tag, { environmentId, kind, notification });
      syncBadge(kind !== "completion");
    },
    [syncBadge],
  );

  useEffect(() => {
    const activeIds = new Set(environmentIds);
    const count = pending.current.size;
    for (const [tag, { environmentId, notification }] of pending.current) {
      if (activeIds.has(environmentId)) continue;
      notification?.close();
      pending.current.delete(tag);
    }
    if (count !== pending.current.size) syncBadge();
  }, [environmentIds, syncBadge]);

  useEffect(() => {
    const clear = () => {
      for (const { notification } of pending.current.values()) notification?.close();
      pending.current.clear();
      setNotificationBadge(0);
    };
    clear();
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, []);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  return environmentIds.map((environmentId) => (
    <Fragment key={environmentId}>
      <HermesCronWatcher environmentId={environmentId} onAttention={onAttention} />
      <EnvironmentNotifications environmentId={environmentId} onAttention={onAttention} />
    </Fragment>
  ));
}

interface PendingAttention {
  readonly environmentId: EnvironmentId;
  readonly kind: AttentionKind;
  readonly notification: Notification | null;
}

/** Records an alert the user has not seen yet because the window was in the background. */
export type OnAttention = (
  environmentId: EnvironmentId,
  tag: string,
  kind: AttentionKind,
  notification: Notification | null,
) => void;

interface NotificationState {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly attention: string | null;
  readonly completion: number | null;
}

function EnvironmentNotifications({
  environmentId,
  onAttention,
}: {
  environmentId: EnvironmentId;
  onAttention: OnAttention;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const threads =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : null;
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const previous = useRef(new Map<ThreadId, NotificationState>());

  useEffect(() => {
    if (threads === null) {
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, NotificationState>();
    const subagentRequests = pendingSubagentRequestsByThread(threads);
    for (const rawThread of threads) {
      if (rawThread.lineage.relationshipToParent === "subagent") continue;
      const prior = previous.current.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (prior?.raw === rawThread && prior.subagentRequest === subagentRequest) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const attention =
        status === "input" || status === "approval" || status === "failed" || status === "limited"
          ? `${thread.latestRun?.runId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      // A watched pull request will wake the agent later, but its turn is over.
      const turnOver =
        status === "ready" || (status === "monitoring" && thread.runtime?.status !== "idle");
      const completion =
        turnOver && thread.latestRun?.status === "completed" && Number.isFinite(completedAt)
          ? completedAt
          : (prior?.completion ?? null);
      next.set(thread.id, { raw: rawThread, subagentRequest, attention, completion });
      if (!prior || thread.archivedAt !== null || isHermesTasksAnnouncedTurn(rawThread)) continue;
      const kind =
        attention && attention !== prior.attention
          ? "input"
          : completion !== null && (prior.completion === null || completion > prior.completion)
            ? "completion"
            : null;
      if (!kind) continue;
      const title =
        kind === "completion"
          ? "Thread completed"
          : status === "approval"
            ? "Approval needed"
            : status === "limited"
              ? "Usage limit reached"
              : status === "failed"
                ? "Thread failed"
                : "Input needed";
      if (hasNotificationSound(mode)) {
        void playNotificationSound(kind, () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      if (
        inAppNotificationsEnabled &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        (activeEnvironmentId !== environmentId || activeThreadId !== thread.id)
      ) {
        const toastId = toastManager.add({
          type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
          title,
          description: thread.title,
          data: {
            hideCopyButton: true,
            leadingIcon:
              kind === "completion" ? (
                <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
              ) : status === "approval" ? (
                <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
              ) : status === "failed" ? (
                <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
              ) : (
                <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
              ),
          },
          actionProps: {
            children: "Open thread",
            onClick: () => {
              toastManager.close(toastId);
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: thread.id },
              });
            },
          },
        });
        continue;
      }
      if (document.visibilityState === "visible" && document.hasFocus()) continue;
      const tag = `${environmentId}:${thread.id}`;
      const badgeKind = kind === "input" && status === "failed" ? "failed" : kind;
      if (
        !hasDesktopNotifications(mode) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      ) {
        onAttention(environmentId, tag, badgeKind, null);
        continue;
      }
      try {
        const notification = new Notification(title, { body: thread.title, tag, silent: true });
        onAttention(environmentId, tag, badgeKind, notification);
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: thread.id },
          });
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
        onAttention(environmentId, tag, badgeKind, null);
      }
    }
    previous.current = next;
  }, [
    activeEnvironmentId,
    activeThreadId,
    environmentId,
    inAppNotificationsEnabled,
    mode,
    navigate,
    onAttention,
    threads,
  ]);

  return null;
}
