/**
 * The read-only Hermes conversation surface: one gateway chat (Discord, ...)
 * as Hermes saw it, or a picker of recent ones while no conversation is chosen.
 *
 * Everything comes from on-demand `hermes.chatList` / `hermes.chatTranscript`
 * reads through the environment's server, so it works the same remotely.
 * Nothing here can reply: the conversation belongs to the platform.
 */
import {
  describeHermesChatAvailability,
  describeHermesChatTools,
  formatHermesChatAge,
  formatHermesChatTime,
  hermesChatConversationSubtitle,
  hermesChatConversationTitle,
  hermesChatPlatformLabel,
  hermesChatTranscriptItems,
  type HermesChatTranscriptItem,
} from "@t3tools/client-runtime/state/hermesChat";
import type {
  EnvironmentId,
  HermesChatConversation,
  HermesChatMessage,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { ArrowLeftRightIcon, ChevronRightIcon, MessagesSquare } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";

const LIVE_REFRESH_MS = 5_000;

/**
 * Rereads every few seconds while the surface is mounted. A hidden tab skips
 * its ticks and a read still in flight is never doubled, so a slow store
 * cannot pile reads up.
 */
function useHermesChatLiveRefresh(query: {
  readonly refresh: () => void;
  readonly isPending: boolean;
}) {
  const tick = useEffectEvent(() => {
    if (document.visibilityState === "visible" && !query.isPending) query.refresh();
  });
  useEffect(() => {
    const timer = setInterval(tick, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
}

function Unavailable(props: { readonly title: string; readonly detail: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessagesSquare />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.detail}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-2 p-3" aria-busy>
      <Skeleton className="h-10" />
      <Skeleton className="h-10" />
      <Skeleton className="h-10" />
    </div>
  );
}

export function HermesChatPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly sessionKey: string | null;
}) {
  const [picking, setPicking] = useState(false);
  const open = (conversation: HermesChatConversation) => {
    setPicking(false);
    useRightPanelStore
      .getState()
      .openHermesChat(
        props.threadRef,
        conversation.sessionKey,
        hermesChatConversationTitle(conversation),
      );
  };
  if (props.sessionKey === null || picking) {
    return (
      <HermesChatPicker
        environmentId={props.environmentId}
        selectedKey={props.sessionKey}
        onOpen={open}
        {...(props.sessionKey === null ? {} : { onCancel: () => setPicking(false) })}
      />
    );
  }
  return (
    <HermesChatTranscriptView
      environmentId={props.environmentId}
      sessionKey={props.sessionKey}
      onSwitch={() => setPicking(true)}
    />
  );
}

function HermesChatPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly selectedKey: string | null;
  readonly onOpen: (conversation: HermesChatConversation) => void;
  readonly onCancel?: () => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.hermesChatList({
      environmentId: props.environmentId,
      input: { limit: 50 },
    }),
  );
  useHermesChatLiveRefresh(query);
  const result = query.data;
  const unavailable = result === null ? null : describeHermesChatAvailability(result.availability);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">Hermes conversations</p>
          <p className="truncate text-2xs text-muted-foreground">
            Recent gateway chats, newest first
          </p>
        </div>
        {props.onCancel === undefined ? null : (
          <Button size="compact" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh"
          disabled={query.isPending}
          onClick={query.refresh}
        >
          <RefreshIcon refreshing={query.isPending} />
        </Button>
      </header>
      {query.error !== null && result === null ? (
        <Unavailable title="Could not list conversations" detail={query.error} />
      ) : result === null ? (
        <LoadingRows />
      ) : unavailable !== null ? (
        <Unavailable {...unavailable} />
      ) : result.conversations.length === 0 ? (
        <Unavailable
          title="No recent conversations"
          detail="Hermes has not talked on any messaging platform in the last 30 days."
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col p-1.5">
            {result.conversations.map((conversation) => (
              <li key={conversation.sessionKey}>
                <button
                  type="button"
                  aria-current={conversation.sessionKey === props.selectedKey ? "true" : undefined}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60 aria-[current=true]:bg-accent"
                  onClick={() => props.onOpen(conversation)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {hermesChatConversationTitle(conversation)}
                      </span>
                      <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                        {formatHermesChatAge(conversation.lastActivityAt)}
                      </span>
                    </span>
                    <span className="block truncate text-2xs text-muted-foreground">
                      {hermesChatConversationSubtitle(conversation)}
                    </span>
                    {conversation.latestMessagePreview === null ? null : (
                      <span className="block truncate text-xs text-muted-foreground/90">
                        {conversation.latestMessagePreview}
                      </span>
                    )}
                  </span>
                  <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}

function HermesChatTranscriptView(props: {
  readonly environmentId: EnvironmentId;
  readonly sessionKey: string;
  readonly onSwitch: () => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.hermesChatTranscript({
      environmentId: props.environmentId,
      input: { sessionKey: props.sessionKey },
    }),
  );
  useHermesChatLiveRefresh(query);
  const result = query.data;
  const conversation = result?.conversation ?? null;
  const unavailable = result === null ? null : describeHermesChatAvailability(result.availability);
  const items = result === null ? [] : hermesChatTranscriptItems(result.messages);
  const newestId = result?.messages.at(-1)?.id ?? null;

  // Follow new messages only while the reader is already at the bottom.
  const bottomRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  useLayoutEffect(() => {
    if (newestId !== null && pinnedRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [newestId]);
  useEffect(() => {
    const bottom = bottomRef.current;
    if (bottom === null) return;
    const observer = new IntersectionObserver(([entry]) => {
      pinnedRef.current = entry?.isIntersecting ?? true;
    });
    observer.observe(bottom);
    return () => observer.disconnect();
  }, [result === null]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {conversation === null
              ? "Hermes conversation"
              : hermesChatConversationTitle(conversation)}
          </p>
          <p className="truncate text-2xs text-muted-foreground">
            {conversation === null
              ? props.sessionKey
              : `${hermesChatConversationSubtitle(conversation)} · ${formatHermesChatAge(conversation.lastActivityAt)}`}
          </p>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Switch conversation"
          onClick={props.onSwitch}
        >
          <ArrowLeftRightIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh"
          disabled={query.isPending}
          onClick={query.refresh}
        >
          <RefreshIcon refreshing={query.isPending} />
        </Button>
      </header>
      {query.error !== null && result === null ? (
        <Unavailable title="Could not read this conversation" detail={query.error} />
      ) : result === null ? (
        <LoadingRows />
      ) : unavailable !== null ? (
        <Unavailable {...unavailable} />
      ) : conversation === null ? (
        <Unavailable
          title="Conversation not found"
          detail="Hermes has no conversation under this key. Switch to pick another."
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 p-3">
            {result.truncated ? (
              <p className="text-center text-2xs text-muted-foreground">
                Showing the newest {result.messages.length} messages
              </p>
            ) : null}
            {items.map((item) => (
              <TranscriptItem key={itemKey(item)} item={item} />
            ))}
            <div ref={bottomRef} className="h-px" />
          </div>
        </ScrollArea>
      )}
      <footer className="border-t border-border/60 px-3 py-1.5 text-center text-2xs text-muted-foreground">
        Read-only. Reply in{" "}
        {conversation === null ? "the chat" : hermesChatPlatformLabel(conversation.platform)}
      </footer>
    </div>
  );
}

function itemKey(item: HermesChatTranscriptItem): string {
  return item.kind === "message" ? `message:${item.message.id}` : item.id;
}

function TranscriptItem({ item }: { readonly item: HermesChatTranscriptItem }) {
  switch (item.kind) {
    case "session":
      return (
        <p className="py-1 text-center text-2xs text-muted-foreground">
          New Hermes session · {formatHermesChatTime(item.timestamp)}
        </p>
      );
    case "tools":
      return <ToolRun item={item} />;
    case "message":
      return <MessageBubble message={item.message} />;
  }
}

function ToolRun({
  item,
}: {
  readonly item: Extract<HermesChatTranscriptItem, { kind: "tools" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="text-2xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex items-center gap-1 rounded px-1 hover:text-foreground"
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRightIcon className={expanded ? "size-3 shrink-0 rotate-90" : "size-3 shrink-0"} />
        {describeHermesChatTools(item)}
      </button>
      {expanded ? (
        <ul className="mt-0.5 flex flex-col gap-0.5 border-l border-border/60 pl-3 font-mono">
          {item.messages.map((message) => (
            <li key={message.id} className="truncate">
              {message.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function MessageBubble({ message }: { readonly message: HermesChatMessage }) {
  const fromUser = message.role === "user";
  return (
    <div className={fromUser ? "flex flex-col items-end" : "flex flex-col items-start"}>
      <div
        className={
          fromUser
            ? "max-w-[85%] rounded-lg bg-secondary px-3 py-2 text-sm"
            : "max-w-full px-1 text-sm"
        }
      >
        {message.replyTo === null ? null : (
          <p className="mb-1 truncate border-l-2 border-border pl-2 text-2xs text-muted-foreground">
            {message.replyTo}
          </p>
        )}
        {fromUser ? (
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
        ) : (
          <ChatMarkdown text={message.text} cwd={undefined} />
        )}
      </div>
      <span className="px-1 pt-0.5 text-2xs text-muted-foreground tabular-nums">
        {formatHermesChatTime(message.timestamp)}
      </span>
    </div>
  );
}
