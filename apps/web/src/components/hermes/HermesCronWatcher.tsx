/** Shares the notification coordinator's badge and audio ownership across all Hermes hosts. */
import type { EnvironmentId } from "@t3tools/contracts";

import type { OnAttention } from "../ThreadNotificationCoordinator";

import { useHermesEnvironmentEnabled } from "../../state/hermesCron";
import { useHermesCronNotifications } from "./useHermesCronNotifications";

export interface HermesCronWatcherProps {
  readonly environmentId: EnvironmentId;
  readonly onAttention: OnAttention;
}

function EnabledHermesCronWatcher(props: HermesCronWatcherProps) {
  useHermesCronNotifications(props);
  return null;
}

export function HermesCronWatcher(props: HermesCronWatcherProps) {
  const enabled = useHermesEnvironmentEnabled(props.environmentId);
  return enabled ? <EnabledHermesCronWatcher {...props} /> : null;
}
