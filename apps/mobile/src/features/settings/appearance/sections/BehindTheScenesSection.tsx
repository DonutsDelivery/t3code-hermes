import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../../../components/ui/AppText";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";

/** Device-local switches for naming skill and memory tool calls in the work log. */
export function BehindTheScenesSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferences);
  const showSkillRows = ready && preferences.value.showSkillActivityRows === true;
  const showMemoryRows = ready && preferences.value.showMemoryActivityRows === true;

  return (
    <View className="gap-3">
      <SettingsSection title="Behind the scenes">
        <SettingsSwitchRow
          disabled={!ready}
          icon="book"
          label="Skill activity"
          value={showSkillRows}
          onValueChange={(value) => savePreferences({ showSkillActivityRows: value })}
        />
        <SettingsSwitchRow
          disabled={!ready}
          icon="brain"
          label="Memory activity"
          value={showMemoryRows}
          onValueChange={(value) => savePreferences({ showMemoryActivityRows: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Name the skills an agent loads or edits, and what it saves to or recalls from memory, in the
        work log.
      </Text>
    </View>
  );
}
