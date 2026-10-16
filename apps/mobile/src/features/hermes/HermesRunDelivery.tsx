import type { EnvironmentId, HermesCronRun, HermesCronRunOutput } from "@t3tools/contracts";
import { IconChevronRight } from "@tabler/icons-react-native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { resolveNativeMarkdownTypography } from "../../lib/appearancePreferences";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useFontFamily } from "../../lib/useFontFamily";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

export function HermesRunDelivery(props: {
  readonly environmentId: EnvironmentId;
  readonly run: HermesCronRun;
}) {
  const [expanded, setExpanded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const iconColor = useUniwindTheme()["--color-icon-muted"];
  const delivery = props.run.delivery;
  const outputAvailable = delivery?.contentAvailable || Boolean(delivery?.preview);
  const inProgress =
    props.run.status === "claimed" ||
    props.run.status === "running" ||
    delivery?.status === "pending" ||
    delivery?.status === "delivering";

  return (
    <View className="gap-1">
      {delivery ? (
        <>
          <Text
            className={
              delivery.status === "failed"
                ? "text-xs text-destructive"
                : "text-xs text-foreground-muted"
            }
          >
            Delivery: {delivery.status === "unrecorded" ? "not recorded" : delivery.status}
          </Text>
          {delivery.targets.length > 0 ? (
            <Text className="text-xs text-foreground-muted">
              Targets: {delivery.targets.join(", ")}
            </Text>
          ) : null}
          {delivery.error ? (
            <Text className="font-mono text-xs text-destructive" selectable>
              {delivery.error}
            </Text>
          ) : null}
          {!expanded && delivery.preview ? (
            <Text className="text-sm text-foreground" numberOfLines={3}>
              {delivery.preview}
            </Text>
          ) : null}
          {!expanded && delivery.truncated ? (
            <Text className="text-xs text-foreground-muted">Preview shortened.</Text>
          ) : null}
        </>
      ) : null}
      {outputAvailable ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? "Hide run output" : "Show run output"}
            accessibilityState={{ expanded }}
            onPress={() => setExpanded((current) => !current)}
            className="min-h-11 flex-row items-center gap-2"
          >
            {/* Rotate a wrapper: react-native-svg applies a root `style.transform` to the drawing
                around its origin, which moves the chevron out of its box on iOS. */}
            <View className={expanded ? "rotate-90" : undefined}>
              <IconChevronRight color={String(iconColor)} size={16} />
            </View>
            <Text className="text-sm text-foreground">
              {expanded ? "Hide output" : "Show output"}
            </Text>
          </Pressable>
          {expanded ? (
            <RunOutput
              key={`${props.environmentId}:${props.run.jobId}:${props.run.id}:${attempt}`}
              environmentId={props.environmentId}
              run={props.run}
              onRetry={() => setAttempt((current) => current + 1)}
            />
          ) : null}
        </>
      ) : (
        <Text className="text-xs text-foreground-muted">
          {inProgress ? "Output is not available yet." : "Run output is unavailable."}
        </Text>
      )}
    </View>
  );
}

type OutputState =
  | { readonly status: "pending" }
  | { readonly status: "error" }
  | { readonly status: "loaded"; readonly output: HermesCronRunOutput };

// Mounted only after a run is expanded; snapshots never trigger full-output requests.
function RunOutput(props: {
  readonly environmentId: EnvironmentId;
  readonly run: HermesCronRun;
  readonly onRetry: () => void;
}) {
  const getRunOutput = useAtomCommand(serverEnvironment.hermesCronGetRunOutput, {
    reportFailure: false,
  });
  const [state, setState] = useState<OutputState>({ status: "pending" });
  const { environmentId, run } = props;

  useEffect(() => {
    let active = true;
    void getRunOutput({ environmentId, input: { jobId: run.jobId, runId: run.id } }).then(
      (result) => {
        if (!active) return;
        setState(
          result._tag === "Success"
            ? { status: "loaded", output: result.value }
            : { status: "error" },
        );
      },
    );
    return () => {
      active = false;
    };
  }, [environmentId, getRunOutput, run.id, run.jobId]);

  if (state.status === "pending") {
    return <Text className="text-sm text-foreground-muted">Loading output…</Text>;
  }
  if (state.status === "error" || !state.output.content) {
    return (
      <View className="gap-1">
        <Text className="text-sm text-foreground-muted">
          {state.status === "error"
            ? "Could not load run output."
            : "Output is no longer available."}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={props.onRetry}
          className="min-h-11 justify-center"
        >
          <Text className="text-sm text-foreground">Try again</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View className="gap-2">
      {state.output.source ? (
        <Text className="text-xs text-foreground-muted">
          Source: {state.output.source === "session" ? "session output" : "delivery output"}
        </Text>
      ) : null}
      <RunOutputMarkdown content={state.output.content} />
      {state.output.truncated ? (
        <Text className="text-xs text-foreground-muted">
          Output shortened because it exceeds the display limit.
        </Text>
      ) : null}
    </View>
  );
}

function RunOutputMarkdown({ content }: { readonly content: string }) {
  const { appearance } = useAppearancePreferences();
  const theme = useUniwindTheme();
  const fontFamily = useFontFamily("regular");
  const boldFontFamily = useFontFamily("bold");
  const textStyle = useMemo(
    () => ({
      ...resolveNativeMarkdownTypography(appearance.baseFontSize),
      color: theme["--color-md-body"],
      strongColor: theme["--color-md-strong"],
      mutedColor: theme["--color-md-body"],
      linkColor: theme["--color-md-link"],
      inlineCodeColor: theme["--color-md-code-text"],
      codeColor: theme["--color-md-code-text"],
      codeBackgroundColor: theme["--color-md-code-bg"],
      codeBlockBackgroundColor: theme["--color-md-code-bg"],
      fileTextColor: theme["--color-md-code-text"],
      skillTextColor: theme["--color-md-code-text"],
      quoteMarkerColor: theme["--color-md-blockquote-border"],
      dividerColor: theme["--color-md-hr"],
      fontFamily,
      headingFontFamily: boldFontFamily,
      boldFontFamily,
    }),
    [appearance.baseFontSize, boldFontFamily, fontFamily, theme],
  );

  return (
    <SelectableMarkdownText
      markdown={content}
      textStyle={textStyle}
      onLinkPress={(href) => void tryOpenExternalUrl(href, "markdown-link")}
    />
  );
}
