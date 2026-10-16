import {
  describeHermesMemoryUsage,
  HERMES_MEMORY_LABELS,
  hermesMemoryChars,
  hermesMemoryDraftUsage,
  normalizeHermesMemoryEntry,
} from "@t3tools/client-runtime/state/hermes-memory";
import type {
  EnvironmentId,
  HermesMemoryFile,
  HermesMemoryMutateInput,
  HermesMemoryTarget,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useHermesMemory } from "../../state/hermesMemory";

type MemoryChange =
  | {
      readonly action: "edit";
      readonly file: HermesMemoryFile;
      readonly oldText: string | null;
      readonly content: string;
    }
  | { readonly action: "remove"; readonly file: HermesMemoryFile; readonly oldText: string };

export function HermesNativeMemorySection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const memory = useHermesMemory(environmentId);
  const disabled = memory.snapshot?.availability === "providerDisabled";
  const unavailable =
    memory.error ??
    memory.snapshot?.detail ??
    (disabled
      ? "Enable the Hermes provider in this environment to use its memory."
      : memory.snapshot?.availability === "unreadable"
        ? "Hermes memory could not be read in this environment."
        : null);

  return (
    <View className="mb-5 gap-3">
      <Text accessibilityRole="header" className="text-base font-t3-semibold text-foreground">
        Hermes memory
      </Text>
      <Text className="text-sm leading-5 text-foreground-muted">
        Hermes keeps these notes and your profile across conversations in this environment.
      </Text>
      {unavailable === null ? null : (
        <View className="gap-2">
          <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
            {unavailable}
          </Text>
          <MemoryButton label="Refresh memory" onPress={memory.retry} />
        </View>
      )}
      {(["memory", "user"] as const).map((target) => (
        <MemoryFileCard
          key={target}
          target={target}
          file={memory.snapshot?.files.find((file) => file.target === target) ?? null}
          loading={memory.snapshot === null && memory.error === null}
          readOnly={memory.snapshot?.availability !== "ready" || memory.error !== null}
          pending={memory.pendingTarget === target}
          mutationPending={memory.pendingTarget !== null}
          mutate={memory.mutate}
        />
      ))}
    </View>
  );
}

function MemoryFileCard(props: {
  readonly target: HermesMemoryTarget;
  readonly file: HermesMemoryFile | null;
  readonly loading: boolean;
  readonly readOnly: boolean;
  readonly pending: boolean;
  readonly mutationPending: boolean;
  readonly mutate: (input: HermesMemoryMutateInput) => Promise<string | null>;
}) {
  const { file } = props;
  const labels = HERMES_MEMORY_LABELS[props.target];
  const [change, setChange] = useState<MemoryChange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editable = file !== null && file.error === null && !props.readOnly;
  const draftUsage =
    change?.action === "edit"
      ? hermesMemoryDraftUsage(change.file, change.oldText, change.content)
      : null;
  const draftLimit = file?.charLimit ?? change?.file.charLimit;
  const overLimit = draftUsage !== null && draftLimit !== undefined && draftUsage > draftLimit;

  const openEditor = (oldText: string | null) => {
    if (!editable || file === null) return;
    setError(null);
    // Keep the opening snapshot: live updates must not silently authorize a stale edit.
    setChange({ action: "edit", file, oldText, content: oldText ?? "" });
  };
  const openRemoval = (oldText: string) => {
    if (!editable || file === null) return;
    setError(null);
    setChange({ action: "remove", file, oldText });
  };
  const cancel = () => {
    setChange(null);
    setError(null);
  };
  const submit = async () => {
    if (change === null || !editable || props.mutationPending) return;
    const base = { target: props.target, revision: change.file.revision };
    const input: HermesMemoryMutateInput =
      change.action === "remove"
        ? { ...base, action: "remove", oldText: change.oldText }
        : change.oldText === null
          ? { ...base, action: "add", content: change.content }
          : { ...base, action: "replace", oldText: change.oldText, content: change.content };
    const failure = await props.mutate(input);
    if (failure !== null) {
      setError(failure);
      return;
    }
    cancel();
  };

  return (
    <View className="gap-3 rounded-[20px] border border-border bg-card p-4">
      <View className="gap-1">
        <Text accessibilityRole="header" className="text-base font-t3-semibold text-foreground">
          {labels.title}
        </Text>
        <Text className="text-sm leading-5 text-foreground-muted">{labels.description}</Text>
      </View>
      {file === null ? (
        <Text className="text-sm text-foreground-muted">
          {props.loading ? "Loading…" : "This file is unavailable."}
        </Text>
      ) : file.error !== null ? (
        <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
          Read-only: {file.error}
        </Text>
      ) : (
        <MemoryUsage file={file} />
      )}
      {file?.entries.length === 0 && file.error === null ? (
        <Text className="text-sm text-foreground-muted">No entries yet.</Text>
      ) : null}
      {file?.entries.map((entry, index) => (
        <View key={entry} className="gap-1 border-t border-border pt-3">
          <Text selectable className="text-base leading-6 text-foreground">
            {entry}
          </Text>
          {editable && change === null ? (
            <View className="flex-row flex-wrap gap-2">
              <MemoryButton
                label="Edit"
                accessibilityLabel={`Edit ${labels.title.toLowerCase()} entry ${index + 1}`}
                disabled={props.mutationPending}
                onPress={() => openEditor(entry)}
              />
              <MemoryButton
                label="Remove"
                accessibilityLabel={`Remove ${labels.title.toLowerCase()} entry ${index + 1}`}
                disabled={props.mutationPending}
                onPress={() => openRemoval(entry)}
              />
            </View>
          ) : null}
        </View>
      ))}
      {change === null ? (
        editable ? (
          <MemoryButton
            label="Add entry"
            disabled={props.mutationPending}
            onPress={() => openEditor(null)}
          />
        ) : null
      ) : (
        <View className="gap-3 border-t border-border pt-3">
          {change.action === "remove" ? (
            <>
              <Text accessibilityRole="header" className="text-sm font-t3-semibold text-foreground">
                Remove this entry?
              </Text>
              <Text selectable className="text-sm leading-5 text-foreground">
                {change.oldText}
              </Text>
              <Text className="text-sm text-foreground-muted">This cannot be undone.</Text>
            </>
          ) : (
            <>
              <Text className="text-sm font-t3-semibold text-foreground">
                {change.oldText === null ? "Add entry" : "Edit entry"}
              </Text>
              <TextInput
                accessibilityLabel={`${labels.title} entry`}
                className="min-h-28 rounded-[16px] bg-subtle px-4 py-3 text-base text-foreground"
                editable={!props.pending}
                multiline
                onChangeText={(content) => setChange({ ...change, content })}
                placeholder="Something worth remembering…"
                placeholderTextColorClassName="accent-placeholder"
                selectionColorClassName="accent-focus/32"
                cursorColorClassName="accent-focus"
                selectionHandleColorClassName="accent-focus"
                textAlignVertical="top"
                value={change.content}
              />
              <Text className="text-xs text-foreground-muted">
                {hermesMemoryChars([normalizeHermesMemoryEntry(change.content)]).toLocaleString()}{" "}
                characters in entry · {draftUsage?.toLocaleString()} of{" "}
                {draftLimit?.toLocaleString()} after saving
              </Text>
              {overLimit ? (
                <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
                  Over the character limit. Shorten the entry before saving.
                </Text>
              ) : null}
            </>
          )}
          {file !== null && file.revision !== change.file.revision ? (
            <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
              This file changed since you opened it. Copy any draft, then cancel and reopen to use
              the latest version.
            </Text>
          ) : null}
          {error === null ? null : (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              className="text-sm text-foreground-muted"
            >
              {error}
            </Text>
          )}
          <View className="flex-row flex-wrap gap-2">
            <MemoryButton
              label={
                props.pending
                  ? change.action === "remove"
                    ? "Removing…"
                    : "Saving…"
                  : change.action === "remove"
                    ? "Confirm removal"
                    : "Save entry"
              }
              busy={props.pending}
              disabled={
                !editable ||
                props.mutationPending ||
                overLimit ||
                (change.action === "edit" &&
                  normalizeHermesMemoryEntry(change.content).length === 0)
              }
              onPress={() => void submit()}
            />
            <MemoryButton label="Cancel" disabled={props.pending} onPress={cancel} />
          </View>
        </View>
      )}
    </View>
  );
}

function MemoryUsage({ file }: { readonly file: HermesMemoryFile }) {
  const ratio = file.charLimit > 0 ? Math.min(1, Math.max(0, file.charsUsed / file.charLimit)) : 0;
  const usage = describeHermesMemoryUsage(file);
  return (
    <View className="gap-2">
      <Text className="text-xs text-foreground-muted">{usage}</Text>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={`${HERMES_MEMORY_LABELS[file.target].title} character usage`}
        accessibilityValue={{
          min: 0,
          max: Math.max(0, file.charLimit),
          now: Math.min(file.charsUsed, Math.max(0, file.charLimit)),
          text: usage,
        }}
        className="h-2 overflow-hidden rounded-full bg-primary/15"
      >
        <View className="h-full rounded-r-full bg-primary" style={{ width: `${ratio * 100}%` }} />
      </View>
    </View>
  );
}

function MemoryButton(props: {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled ?? false, busy: props.busy ?? false }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.disabled
          ? "min-h-11 items-center justify-center rounded-full bg-subtle px-4 opacity-50"
          : "min-h-11 items-center justify-center rounded-full bg-subtle px-4"
      }
    >
      <Text className="text-sm font-t3-semibold text-foreground">{props.label}</Text>
    </Pressable>
  );
}
