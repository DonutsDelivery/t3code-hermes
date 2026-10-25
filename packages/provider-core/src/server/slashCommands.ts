/**
 * Shared dedupe for snapshot `slashCommands`, so the composer menu gets one entry per name from
 * Claude or ACP agents.
 */
import type { ServerProviderSlashCommand } from "@t3tools/contracts";

function nonEmptyString(value: string | null | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate ? candidate : undefined;
}

/**
 * Collapse commands by case-insensitive name, keeping the first occurrence and
 * backfilling a missing description or input hint from later duplicates.
 */
export function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}
