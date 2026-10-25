# Read Hermes conversations

When Hermes runs its messaging gateway, it also talks to people on Discord (and Telegram, Slack,
and the other platforms it supports) outside any T3 Code thread. The **Hermes conversation**
surface shows one of those chats in the right panel, so you can follow along without leaving the
app.

It is read-only. You cannot reply from T3 Code, and opening a conversation never starts a Hermes
turn; to answer, use the platform itself.

## Open a conversation

From a thread, open the right panel's **Open a surface** list and choose **Hermes conversation**
(shortcut `H`), or run **Open Hermes conversation…** from the command palette. Both open a list of
the chats Hermes was active in over the last 30 days, newest first. Choose one to read it; the
switch button in its header takes you back to the list. Each conversation gets its own tab, so you
can keep several open.

The surface needs the Hermes provider turned on in Settings, and reads the default Hermes
profile.

## What it shows

- The whole conversation, even after Hermes reset it or compressed its context and carried on in a
  new session. A divider marks where each new session starts. Very long conversations show the
  newest 500 messages.
- Messages as people wrote them, without the reply quotes and channel history Hermes adds for the
  model. A reply shows the message it answers above it.
- Hermes's tool use as one collapsed line per run of steps. Select it to see each step.

While the surface is open and the window is visible, it checks for new messages every few
seconds. Transcripts are read from Hermes when you look at them and are not saved in T3 Code.

## Link a conversation to a thread

A linked conversation shows up as a card in a thread's timeline, updated as the chat moves. Select
the card to open the conversation; **Detach** takes the card down. A detached conversation stays out
of an auto-linking hub until you link it again, and the hub fills the slot with its next newest
conversation. To link the conversation you are
reading to the thread the panel belongs to, use **Link to this thread** in its header, and
**Unlink** to undo it. Opening a conversation never links it.

## Thread hubs

A hub is one pinned thread that collects the conversations from Discord channels you name. Set
them up in **Settings › Integrations › External thread hubs**: add a hub, give it a name and the
channel ids (separated by commas or spaces), then pick one of the environment's pinned threads or
create one. A hub marked **Needs a thread** has no thread, or its thread is gone or unpinned, and
links nothing until you pick one.

With **Link new conversations** on, each new conversation in the hub's channels links itself,
keeping the newest few up to the cap you set.

Hermes can also ask for a link by appending a line to `t3-hub-links.jsonl` in the Hermes home:

```json
{ "sessionKey": "agent:main:discord:...", "hub": "Ops", "reason": "deploy question" }
```

`hub` is the hub's id or name. `action` is `link` (the default) or `unlink`; `reason` and `at` are
optional. A line is ignored unless the conversation is in one of that hub's channels.

Known limit: a
brand-new hub thread is not marked unread until it has had at least one run.

## Agent tools

Agents can read the same conversations with `hermes_chat_list` and `hermes_chat_read`, list hubs
with `hermes_hub_list`, and link or unlink a conversation with `hermes_chat_link` and
`hermes_chat_unlink`: to the calling thread, or with `hub` to that hub's thread.
