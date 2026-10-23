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
import { AlertTriangleIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { useHermesMemory } from "../../state/hermesMemory";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const TARGETS: readonly HermesMemoryTarget[] = ["memory", "user"];

type Editor =
  | { action: "add" | "replace"; file: HermesMemoryFile; oldText: string | null; content: string }
  | { action: "remove"; file: HermesMemoryFile; oldText: string };

/** One ratio, with exact values outside the mark and no animation during live updates. */
function MemoryUsage({ file }: { file: HermesMemoryFile }) {
  const summary = describeHermesMemoryUsage(file);
  const ratio = file.charLimit > 0 ? file.charsUsed / file.charLimit : 0;
  const atLimit = file.charsUsed >= file.charLimit;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>{summary}</span>
        {atLimit ? (
          <span className="inline-flex items-center gap-1">
            <AlertTriangleIcon className="size-3.5" aria-hidden />
            {file.charsUsed > file.charLimit ? "Over limit" : "At limit"}
          </span>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              role="meter"
              aria-label={`${HERMES_MEMORY_LABELS[file.target].title} capacity`}
              aria-valuemin={0}
              aria-valuemax={Math.max(1, file.charLimit)}
              aria-valuenow={Math.max(0, Math.min(file.charsUsed, file.charLimit))}
              aria-valuetext={summary}
              tabIndex={0}
              className="flex h-6 items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <div
            className={`h-1.5 w-full overflow-hidden rounded-sm forced-colors:outline ${atLimit ? "bg-warning/15" : "bg-primary/15"}`}
          >
            <div
              className={`h-full rounded-r-sm forced-colors:border-t-4 forced-colors:border-current ${atLimit ? "bg-warning" : "bg-primary"}`}
              style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }}
            />
          </div>
        </TooltipTrigger>
        <TooltipPopup>{summary}. Entry separators count toward the limit.</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function MemoryFileCard({
  target,
  file,
  unavailable,
  editable,
  mutate,
}: {
  target: HermesMemoryTarget;
  file: HermesMemoryFile | undefined;
  unavailable: string;
  editable: boolean;
  mutate: (input: HermesMemoryMutateInput) => Promise<string | null>;
}) {
  const id = useId();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const labels = HERMES_MEMORY_LABELS[target];
  const readOnly = !editable || file === undefined || file.error !== null;
  const draftUsage =
    editor !== null && editor.action !== "remove"
      ? hermesMemoryDraftUsage(editor.file, editor.oldText, editor.content)
      : null;
  const draftLimit = file?.charLimit ?? editor?.file.charLimit ?? 0;
  const overLimit = draftUsage !== null && draftUsage > draftLimit;
  const stale = editor !== null && file !== undefined && editor.file.revision !== file.revision;

  const open = (next: Editor) => {
    setError(null);
    setEditor(next);
  };
  const close = () => {
    setEditor(null);
    setError(null);
  };
  const save = async () => {
    if (editor === null || readOnly || pendingRef.current) return;
    if (
      editor.action !== "remove" &&
      (normalizeHermesMemoryEntry(editor.content).length === 0 || overLimit)
    )
      return;
    const input: HermesMemoryMutateInput =
      editor.action === "remove"
        ? { target, revision: editor.file.revision, action: "remove", oldText: editor.oldText }
        : editor.oldText === null
          ? { target, revision: editor.file.revision, action: "add", content: editor.content }
          : {
              target,
              revision: editor.file.revision,
              action: "replace",
              oldText: editor.oldText,
              content: editor.content,
            };
    pendingRef.current = true;
    setPending(true);
    setError(null);
    // `mutate` settles into a message instead of rejecting, so cleanup follows the await.
    const failure = await mutate(input);
    pendingRef.current = false;
    setPending(false);
    if (failure !== null) {
      setError(failure);
      return;
    }
    close();
  };

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="min-w-0 rounded-lg border border-border/60 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id={`${id}-title`} className="text-sm font-medium">
            {labels.title}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">{labels.description}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={readOnly || editor !== null}
          onClick={() => {
            if (file !== undefined) open({ action: "add", file, oldText: null, content: "" });
          }}
        >
          Add
        </Button>
      </div>
      {file === undefined ? (
        <p className="mt-3 text-sm text-muted-foreground">{unavailable}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <MemoryUsage file={file} />
          {file.error !== null ? (
            <p role="alert" className="text-sm text-muted-foreground">
              Read only: {file.error}
            </p>
          ) : null}
          {file.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {file.error === null ? "No entries yet." : "Entries could not be read safely."}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border/60">
              {file.entries.map((entry, index) => (
                <li key={entry} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                  <p className="whitespace-pre-wrap break-words text-sm">{entry}</p>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={readOnly || editor !== null}
                      aria-label={`Edit ${labels.title.toLowerCase()} entry ${index + 1}`}
                      onClick={() =>
                        open({ action: "replace", file, oldText: entry, content: entry })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost-destructive"
                      disabled={readOnly || editor !== null}
                      aria-label={`Remove ${labels.title.toLowerCase()} entry ${index + 1}`}
                      onClick={() => open({ action: "remove", file, oldText: entry })}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {editor !== null ? (
        <form
          className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3"
          aria-busy={pending}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {editor.action === "remove" ? (
            <>
              <p className="text-sm font-medium">Remove this entry? This cannot be undone.</p>
              <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {editor.oldText}
              </p>
            </>
          ) : (
            <>
              <label htmlFor={`${id}-draft`} className="text-sm font-medium">
                {editor.action === "add" ? "New entry" : "Edit entry"}
              </label>
              <Textarea
                id={`${id}-draft`}
                autoFocus
                disabled={pending}
                value={editor.content}
                aria-describedby={`${id}-draft-usage`}
                aria-invalid={overLimit}
                onChange={(event) => setEditor({ ...editor, content: event.target.value })}
              />
              <p id={`${id}-draft-usage`} className="text-xs text-muted-foreground">
                {hermesMemoryChars([normalizeHermesMemoryEntry(editor.content)]).toLocaleString()}{" "}
                characters in entry · After saving: {draftUsage?.toLocaleString()} of{" "}
                {draftLimit.toLocaleString()} characters.
                {overLimit ? " Over limit. Shorten this entry before saving." : ""}
              </p>
            </>
          )}
          {stale ? (
            <p role="status" className="text-xs text-muted-foreground">
              This file changed since you opened the editor. Your draft is kept; copy it before
              cancelling and reopening the latest entry. Saving an outdated revision will be
              rejected.
            </p>
          ) : null}
          {error !== null ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              variant={editor.action === "remove" ? "destructive" : "default"}
              disabled={
                readOnly ||
                pending ||
                overLimit ||
                (editor.action !== "remove" &&
                  normalizeHermesMemoryEntry(editor.content).length === 0)
              }
            >
              {pending ? "Saving…" : editor.action === "remove" ? "Confirm remove" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={close}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function NativeMemoryContent({ environmentId }: { environmentId: EnvironmentId | null }) {
  const { data, error, isPending, refresh, mutate } = useHermesMemory(environmentId);
  const unavailable =
    environmentId === null || data?.availability === "providerDisabled"
      ? "Enable the Hermes provider to view and edit native memory."
      : (error ??
        data?.detail ??
        (isPending || data === null ? "Loading native memory…" : "This file is unavailable."));
  return (
    <section aria-label="Hermes memory" className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">Hermes memory</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Persistent notes and your profile, stored by Hermes. No Hindsight service required.
        </p>
      </div>
      {error !== null || (data !== null && data.availability !== "ready") ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="min-w-0 break-words text-sm text-muted-foreground">
            {unavailable}
          </p>
          {environmentId !== null ? (
            <Button size="sm" variant="ghost" onClick={refresh}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      {TARGETS.map((target) => (
        <MemoryFileCard
          key={target}
          target={target}
          file={data?.files.find((file) => file.target === target)}
          unavailable={unavailable}
          editable={data?.availability === "ready" && error === null}
          mutate={mutate}
        />
      ))}
    </section>
  );
}

export function HermesNativeMemorySection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  // A new environment must never inherit another host's draft or revision.
  return <NativeMemoryContent key={environmentId ?? "disabled"} environmentId={environmentId} />;
}
