# See your Paperclip company

The Paperclip surface shows one [Paperclip](https://github.com/paperclipai/paperclip) company at a
glance: its agents in org-chart order, issues with open and blocked work first, recent heartbeat
runs, and activity. It is read-only; to change anything, use the **Open in Paperclip** button in
the surface's header, or select an issue.

## Connect a company

1. In Paperclip, create a separate user for T3 Code and add it to your company with the
   **viewer** role. Paperclip refuses every write from a viewer, so the key cannot change
   anything even if it leaks.
2. Signed in as that user, create a board API key. Board keys expire after 30 days unless you
   set an expiry when you create one.
3. In T3 Code, open **Settings → Integrations → Paperclip**, turn it on, and enter Paperclip's
   address as the environment's server reaches it (for example `http://192.168.1.20:3100`) and
   the key. The **Connection** row confirms the company and says whether the key is read-only.

You can also ask an agent to connect Paperclip for you. It asks for the key in a private card in
the thread, so the key is never shown to the agent or kept in the conversation.

A key that belongs to more than one company shows the first one. To pick another, enter its
company ID in **Company**.

## Open the surface

From a thread, open the right panel's **Open a surface** list and choose **Paperclip** (shortcut
`C`), or run **Show Paperclip** from the command palette.

If the surface says the key was rejected, it has expired or was revoked: create a new one and
save it in Settings.
