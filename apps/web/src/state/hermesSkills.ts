import {
  describeHermesSkillsEmptyState,
  hermesSkillDetailInput,
  resolveHermesSkillSelection,
  selectHermesSkills,
  type HermesSkillOriginFilter,
  type HermesSkillSelection,
} from "@t3tools/client-runtime/state/hermes-skills";
import { useState } from "react";

import { useHermesEnvironmentId } from "./hermesCron";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

export function useHermesSkills() {
  const environmentId = useHermesEnvironmentId();
  const [search, setSearch] = useState("");
  const [origin, setOrigin] = useState<HermesSkillOriginFilter>("all");
  const [selection, setSelection] = useState<HermesSkillSelection | null>(null);
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hermesSkills({ environmentId, input: {} }),
  );
  const snapshot = query.data;
  const selectedSkill = resolveHermesSkillSelection(selection, environmentId, snapshot);
  // Environment, path, and snapshot identity isolate late reads, including
  // store changes that keep the same skill metadata and server reconnects.
  const detailQuery = useEnvironmentQuery(
    environmentId === null || selectedSkill === null || snapshot === null
      ? null
      : serverEnvironment.hermesSkillsGet({
          environmentId,
          input: hermesSkillDetailInput(selectedSkill.path, snapshot),
        }),
  );
  const list = selectHermesSkills(snapshot?.skills ?? [], search, origin);

  return {
    ...list,
    environmentId,
    snapshot,
    search,
    setSearch,
    origin,
    setOrigin,
    selectedSkill,
    selectSkill: (path: string | null) =>
      setSelection(path === null || environmentId === null ? null : { environmentId, path }),
    detail: detailQuery.data,
    detailError: detailQuery.error,
    isDetailPending: detailQuery.isPending && detailQuery.data === null,
    refreshDetail: detailQuery.refresh,
    isPending: query.isPending && snapshot === null,
    error: query.error,
    emptyState: describeHermesSkillsEmptyState(snapshot),
    refresh: query.refresh,
  };
}
