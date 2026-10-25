/**
 * A linked Hermes gateway conversation's card in a thread timeline. The card
 * opens the conversation surface rather than a thread, and Detach removes the
 * link so the server stops refreshing the card here.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessagesSquare } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function HermesChatCardRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly sessionKey: string;
  readonly summary: string;
  readonly detail: string | undefined;
  readonly timestamp: ReactNode;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.hermesChatUnlink.permissionAtom(props.threadRef.environmentId),
  );
  const unlink = useAtomCommand(serverEnvironment.hermesChatUnlink, {
    label: "hermes conversation detach",
  });
  const [detaching, setDetaching] = useState(false);
  const open = () =>
    useRightPanelStore.getState().openHermesChat(props.threadRef, props.sessionKey, props.summary);
  const detach = async () => {
    setDetaching(true);
    const result = await unlink({
      environmentId: props.threadRef.environmentId,
      input: { sessionKey: props.sessionKey, threadId: props.threadRef.threadId },
    });
    setDetaching(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not detach conversation",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  return (
    // A feature-owned card, not a work-log row: conversations in a hub are
    // the thread's content, so they read as cards rather than log lines.
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open Hermes conversation ${props.summary}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
      className="group/hermes-card my-1 flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-xl border border-border/60 bg-card px-3.5 py-3 text-left transition-colors hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
    >
      <div className="flex min-w-0 items-center gap-2">
        <MessagesSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">
          {props.summary}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          {canOperate ? (
            <Button
              size="micro"
              variant="ghost"
              disabled={detaching}
              onClick={(event) => {
                event.stopPropagation();
                void detach();
              }}
            >
              Detach
            </Button>
          ) : null}
          {props.timestamp}
        </div>
      </div>
      {props.detail ? (
        <p className="line-clamp-2 pl-6 text-sm text-muted-foreground">{props.detail}</p>
      ) : null}
    </div>
  );
}
