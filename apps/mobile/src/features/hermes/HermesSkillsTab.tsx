import { LegendList } from "@legendapp/list/react-native";
import {
  formatHermesSkillUpdated,
  formatHermesSkillMetadata,
  HERMES_SKILL_ORIGIN_FILTERS,
  HERMES_SKILL_ORIGIN_LABELS,
} from "@t3tools/client-runtime/state/hermes-skills";
import type { EnvironmentId, HermesSkill } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { useHermesSkills } from "../../state/hermesSkills";
import { FileMarkdownPreview } from "../files/FileMarkdownPreview";

type SkillListItem =
  | { readonly key: string; readonly title: string }
  | { readonly key: string; readonly skill: HermesSkill };

function SkillMetadata({ skill }: { readonly skill: HermesSkill }) {
  const updated = formatHermesSkillUpdated(skill.lastModifiedByHermes);
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      <View className="rounded-full bg-subtle px-2 py-1">
        <Text className="text-xs text-foreground-muted">
          {HERMES_SKILL_ORIGIN_LABELS[skill.origin]}
        </Text>
      </View>
      {skill.version === null ? null : (
        <Text className="text-xs text-foreground-muted">v{skill.version}</Text>
      )}
      <Text className="text-xs text-foreground-muted">{skill.usageCount} uses</Text>
      {updated === null ? null : <Text className="text-xs text-foreground-muted">{updated}</Text>}
    </View>
  );
}

function SkillRow({
  skill,
  onSelect,
}: {
  readonly skill: HermesSkill;
  readonly onSelect: (path: string) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`View skill ${skill.name}`}
      onPress={() => onSelect(skill.path)}
      className="mb-2 gap-2 rounded-2xl border border-border bg-card p-4"
    >
      <Text className="font-t3-semibold text-foreground">{skill.name}</Text>
      <SkillMetadata skill={skill} />
      {skill.description ? (
        <Text numberOfLines={2} className="text-sm text-foreground-muted">
          {skill.description}
        </Text>
      ) : null}
      {skill.tags.length > 0 ? (
        <Text numberOfLines={2} className="text-xs text-foreground-muted">
          {skill.tags.join(" · ")}
        </Text>
      ) : null}
    </Pressable>
  );
}

function TextAction({ label, onPress }: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className="min-h-11 justify-center rounded-full bg-subtle px-4"
    >
      <Text className="text-sm font-t3-medium text-foreground">{label}</Text>
    </Pressable>
  );
}

export function HermesSkillsTab({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const skills = useHermesSkills(environmentId);
  const documentMetadata = formatHermesSkillMetadata(skills.detail?.metadata);
  const insets = useSafeAreaInsets();
  const [showFiles, setShowFiles] = useState(false);
  const rows = useMemo(() => {
    const items: SkillListItem[] = [];
    if (skills.recent.length > 0) {
      items.push({ key: "recent", title: "Recently changed by Hermes" });
      items.push(...skills.recent.map((skill) => ({ key: `recent:${skill.path}`, skill })));
    }
    for (const group of skills.groups) {
      items.push({
        key: `category:${group.category}`,
        title: `${group.category} (${group.skills.length})`,
      });
      items.push(...group.skills.map((skill) => ({ key: `skill:${skill.path}`, skill })));
    }
    return items;
  }, [skills.groups, skills.recent]);

  if (skills.selectedSkill !== null) {
    return (
      <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
        <View className="gap-2 border-b border-border px-4 py-3">
          <View className="flex-row items-center justify-between gap-2">
            <TextAction label="Back to skills" onPress={() => skills.selectSkill(null)} />
            <TextAction label="Refresh" onPress={skills.refreshDetail} />
          </View>
          <Text className="text-lg font-t3-semibold text-foreground">
            {skills.selectedSkill.name}
          </Text>
          <SkillMetadata skill={skills.selectedSkill} />
          {skills.selectedSkill.tags.length > 0 ? (
            <Text className="text-xs text-foreground-muted">
              {skills.selectedSkill.tags.join(" · ")}
            </Text>
          ) : null}
          {documentMetadata ? (
            <Text className="text-xs text-foreground-muted">{documentMetadata}</Text>
          ) : null}
          <Text selectable className="text-xs text-foreground-muted">
            {skills.selectedSkill.path}
          </Text>
          {skills.isDetailPending ? (
            <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
              Loading skill…
            </Text>
          ) : null}
          {skills.detailError ? (
            <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
              {skills.detailError}
            </Text>
          ) : null}
          {skills.detail?.truncated ? (
            <Text className="text-sm text-foreground-muted">
              This preview or its file list is truncated.
            </Text>
          ) : null}
          {skills.detail ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: showFiles }}
                onPress={() => setShowFiles(!showFiles)}
                className="min-h-11 justify-center"
              >
                <Text className="text-sm font-t3-medium text-foreground">
                  {showFiles ? "Hide" : "Show"} sibling files ({skills.detail.files.length})
                </Text>
              </Pressable>
              {showFiles ? (
                <ScrollView style={{ maxHeight: 140 }}>
                  {skills.detail.files.length === 0 ? (
                    <Text className="text-xs text-foreground-muted">No sibling files.</Text>
                  ) : (
                    skills.detail.files.map((file) => (
                      <Text key={file} selectable className="py-1 text-xs text-foreground-muted">
                        {file}
                      </Text>
                    ))
                  )}
                </ScrollView>
              ) : null}
            </>
          ) : null}
        </View>
        {skills.detail ? (
          <FileMarkdownPreview
            key={skills.detail.path}
            environmentId={environmentId}
            markdown={skills.detail.markdown}
            cwd=""
            relativePath={skills.detail.path}
            threadId={null}
            captured
            onRefresh={skills.refreshDetail}
          />
        ) : null}
      </View>
    );
  }

  return (
    <View className="flex-1">
      <View className="gap-3 px-4 pt-3 pb-2">
        <View className="flex-row items-center gap-3">
          <Text className="flex-1 text-sm text-foreground-muted">
            Read-only skill library. Ask Hermes in chat to make changes.
          </Text>
          <TextAction label="Refresh" onPress={skills.refresh} />
        </View>
        <TextInput
          accessibilityLabel="Search skills"
          placeholder="Search skills, descriptions, or tags…"
          placeholderTextColorClassName="accent-placeholder"
          value={skills.search}
          onChangeText={skills.setSearch}
          autoCorrect={false}
          autoCapitalize="none"
          className="min-h-11 rounded-xl border border-border bg-card px-3 text-foreground"
        />
        <View className="flex-row flex-wrap gap-2">
          {HERMES_SKILL_ORIGIN_FILTERS.map((origin) => (
            <Pressable
              key={origin}
              accessibilityRole="button"
              accessibilityState={{ selected: skills.origin === origin }}
              onPress={() => skills.setOrigin(origin)}
              className={
                skills.origin === origin
                  ? "min-h-11 justify-center rounded-full border border-foreground-muted bg-card px-3"
                  : "min-h-11 justify-center rounded-full border border-border px-3"
              }
            >
              <Text className="text-xs text-foreground">{HERMES_SKILL_ORIGIN_LABELS[origin]}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <LegendList
        className="flex-1"
        data={skills.emptyState === null ? rows : []}
        estimatedItemSize={140}
        keyExtractor={(item) => item.key}
        getItemType={(item) => ("title" in item ? "heading" : "skill")}
        renderItem={({ item }) =>
          "title" in item ? (
            <Text
              accessibilityRole="header"
              className="pb-2 pt-4 text-sm font-t3-semibold text-foreground"
            >
              {item.title}
            </Text>
          ) : (
            <SkillRow skill={item.skill} onSelect={skills.selectSkill} />
          )
        }
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View className="gap-2">
            {skills.error ? (
              <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
                {skills.error}
              </Text>
            ) : null}
            {skills.snapshot?.availability === "ready" && skills.snapshot.detail ? (
              <Text className="text-sm text-foreground-muted">{skills.snapshot.detail}</Text>
            ) : null}
            {skills.snapshot?.truncated ? (
              <Text className="text-sm text-foreground-muted">
                This library is truncated. Search and filters cover only the skills shown here.
              </Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <View className="gap-2 py-8">
            <Text className="text-base font-t3-semibold text-foreground">
              {skills.isPending
                ? "Loading skills…"
                : (skills.emptyState?.title ??
                  (skills.snapshot ? "No skills match these filters" : "Skills are unavailable"))}
            </Text>
            {skills.emptyState ? (
              <Text className="text-sm text-foreground-muted">{skills.emptyState.description}</Text>
            ) : null}
          </View>
        }
      />
    </View>
  );
}
