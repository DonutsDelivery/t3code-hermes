/** Consumes live announcements only; snapshots/history never generate alerts. */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { HermesCronView } from "@t3tools/client-runtime/state/hermes-cron";
import { useEffect, useRef } from "react";

import { getClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useHermesCron } from "../../state/hermesCron";
import { markHermesTasksSeen, reportHermesCompletion } from "../../state/hermesCronSeen";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../../threadNotifications";
import { toastManager } from "../ui/toast";
import type { HermesCronWatcherProps } from "./HermesCronWatcher";

export function useHermesCronNotifications({
  environmentId,
  onAttention,
}: HermesCronWatcherProps): void {
  const { view } = useHermesCron(environmentId);
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppEnabled = useClientSettings((settings) => settings.inAppNotificationsEnabled);
  // Snapshot folds retain the completion object. Keep observing even when alerts
  // are disabled so enabling them cannot replay the last completed run.
  const lastSeen = useRef<HermesCronView["lastCompletion"]>(null);

  useEffect(() => {
    const completion = view.lastCompletion;
    if (completion === null || completion === lastSeen.current) return;
    lastSeen.current = completion;
    reportHermesCompletion(environmentId);

    const focused = document.visibilityState === "visible" && document.hasFocus();
    const currentTarget =
      location.pathname === "/hermes" &&
      location.search.environmentId === environmentId &&
      location.search.jobId === completion.jobId &&
      location.search.runId === completion.runId;
    if (focused && currentTarget) markHermesTasksSeen(environmentId);
    const title = `Task ${completion.status === "failed" ? "failed" : "finished"}: ${completion.jobName}`;
    const description =
      completion.delivery?.preview ??
      completion.error ??
      (completion.status === "failed"
        ? "Hermes did not record a reason."
        : "Scheduled run completed.");
    const open = () => {
      markHermesTasksSeen(environmentId);
      void navigate({
        to: "/hermes",
        search: { environmentId, jobId: completion.jobId, runId: completion.runId },
      });
    };
    if (hasNotificationSound(mode)) {
      void playNotificationSound(completion.status === "failed" ? "input" : "completion", () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    if (inAppEnabled && focused && !currentTarget) {
      const toastId = toastManager.add({
        type: completion.status === "failed" ? "error" : "success",
        title,
        description,
        data: { hideCopyButton: true },
        actionProps: {
          children: "Open",
          onClick: () => {
            toastManager.close(toastId);
            open();
          },
        },
      });
      return;
    }
    if (focused) return;
    const tag = JSON.stringify(["hermes", environmentId, completion.jobId, completion.runId]);
    const kind = completion.status === "failed" ? "failed" : "completion";
    if (
      !hasDesktopNotifications(mode) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    ) {
      onAttention(environmentId, tag, kind, null);
      return;
    }
    try {
      const notification = new Notification(title, { body: description, tag, silent: true });
      onAttention(environmentId, tag, kind, notification);
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        open();
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
      onAttention(environmentId, tag, kind, null);
    }
  }, [environmentId, inAppEnabled, location, mode, navigate, onAttention, view.lastCompletion]);
}
