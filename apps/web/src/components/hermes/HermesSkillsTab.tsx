import {
  formatHermesSkillUpdated,
  formatHermesSkillMetadata,
  HERMES_SKILL_ORIGIN_FILTERS,
  HERMES_SKILL_ORIGIN_LABELS,
} from "@t3tools/client-runtime/state/hermes-skills";
import type { EnvironmentId, HermesSkill } from "@t3tools/contracts";
import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";

import { useHermesSkills } from "../../state/hermesSkills";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function SkillMetadata({ skill }: { readonly skill: HermesSkill }) {
  const updated = formatHermesSkillUpdated(skill.lastModifiedByHermes);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="rounded-full bg-muted px-2 py-0.5 font-medium">
        {HERMES_SKILL_ORIGIN_LABELS[skill.origin]}
      </span>
      {skill.version === null ? null : <span>v{skill.version}</span>}
      <span>{skill.usageCount} uses</span>
      {updated === null ? null : (
        <Tooltip>
          <TooltipTrigger render={<span>{updated}</span>} />
          <TooltipPopup>{skill.lastModifiedByHermes}</TooltipPopup>
        </Tooltip>
      )}
    </div>
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
    <li>
      <button
        type="button"
        onClick={() => onSelect(skill.path)}
        className="flex w-full flex-col gap-1.5 rounded-lg border border-border/60 px-3 py-3 text-left hover:bg-accent/40 focus-visible:outline-ring"
      >
        <span className="break-words text-sm font-medium">{skill.name}</span>
        <SkillMetadata skill={skill} />
        {skill.description ? (
          <span className="line-clamp-2 break-words text-sm text-muted-foreground">
            {skill.description}
          </span>
        ) : null}
        {skill.tags.length > 0 ? (
          <span className="text-xs text-muted-foreground">{skill.tags.join(" · ")}</span>
        ) : null}
      </button>
    </li>
  );
}

export function HermesSkillsTab({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const skills = useHermesSkills(environmentId);
  const selected = skills.selectedSkill;
  const documentMetadata = formatHermesSkillMetadata(skills.detail?.metadata);

  if (selected !== null) {
    return (
      <section className="flex min-w-0 flex-col gap-4" aria-label="Skill detail">
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => skills.selectSkill(null)}>
            <ArrowLeftIcon /> Back to skills
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={skills.refreshDetail}
            aria-label="Refresh skill detail"
          >
            <RefreshCwIcon /> Refresh
          </Button>
        </div>
        <h2 className="break-words text-lg font-semibold">{selected.name}</h2>
        <SkillMetadata skill={selected} />
        {selected.tags.length > 0 ? (
          <p className="text-xs text-muted-foreground">{selected.tags.join(" · ")}</p>
        ) : null}
        {documentMetadata ? (
          <p className="break-words text-xs text-muted-foreground">{documentMetadata}</p>
        ) : null}
        <p className="break-all text-xs text-muted-foreground">{selected.path}</p>
        {skills.isDetailPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading skill…
          </p>
        ) : null}
        {skills.detailError ? (
          <p role="alert" className="text-sm text-destructive">
            {skills.detailError}
          </p>
        ) : null}
        {skills.detail === null ? null : (
          <>
            {skills.detail.truncated ? (
              <p className="text-sm text-muted-foreground">
                This preview or its file list is truncated.
              </p>
            ) : null}
            <ChatMarkdown
              text={skills.detail.markdown}
              cwd={undefined}
              environmentId={skills.environmentId ?? undefined}
            />
            <section className="flex flex-col gap-2" aria-label="Sibling files">
              <h3 className="text-sm font-medium">Sibling files</h3>
              {skills.detail.files.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sibling files.</p>
              ) : (
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {skills.detail.files.map((file) => (
                    <li key={file} className="break-all font-mono">
                      {file}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </section>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Hermes&apos;s skill library. Read-only; ask Hermes in chat to make changes.
        </p>
        <Button variant="ghost" size="sm" onClick={skills.refresh} aria-label="Refresh skills">
          <RefreshCwIcon /> Refresh
        </Button>
      </div>
      <Input
        aria-label="Search skills"
        placeholder="Search skills, descriptions, or tags…"
        value={skills.search}
        onChange={(event) => skills.setSearch(event.target.value)}
      />
      <div className="flex flex-wrap gap-2" aria-label="Filter skills by origin">
        {HERMES_SKILL_ORIGIN_FILTERS.map((origin) => (
          <Button
            key={origin}
            variant={skills.origin === origin ? "outline" : "ghost"}
            size="sm"
            aria-pressed={skills.origin === origin}
            onClick={() => skills.setOrigin(origin)}
          >
            {HERMES_SKILL_ORIGIN_LABELS[origin]}
          </Button>
        ))}
      </div>
      {skills.environmentId === null ? (
        <p className="text-sm text-muted-foreground">
          Connect an environment with Hermes enabled to see its skills.
        </p>
      ) : null}
      {skills.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading skills…
        </p>
      ) : null}
      {skills.error ? (
        <p role="alert" className="text-sm text-destructive">
          {skills.error}
        </p>
      ) : null}
      {skills.snapshot?.availability === "ready" && skills.snapshot.detail ? (
        <p role="status" className="text-sm text-muted-foreground">
          {skills.snapshot.detail}
        </p>
      ) : null}
      {skills.snapshot?.truncated ? (
        <p className="text-sm text-muted-foreground">
          This library is truncated. Search and filters cover only the skills shown here.
        </p>
      ) : null}
      {skills.emptyState ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{skills.emptyState.title}</EmptyTitle>
            <EmptyDescription>{skills.emptyState.description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : skills.snapshot !== null && skills.count === 0 ? (
        <p className="text-sm text-muted-foreground">No skills match these filters.</p>
      ) : (
        <>
          {skills.recent.length > 0 ? (
            <section className="space-y-2" aria-label="Recently changed by Hermes">
              <h2 className="text-sm font-medium">Recently changed by Hermes</h2>
              <ul className="space-y-2">
                {skills.recent.map((skill) => (
                  <SkillRow key={skill.path} skill={skill} onSelect={skills.selectSkill} />
                ))}
              </ul>
            </section>
          ) : null}
          {skills.groups.map((group) => (
            <section key={group.category} className="space-y-2" aria-label={group.category}>
              <h2 className="text-sm font-medium">
                {group.category}{" "}
                <span className="text-muted-foreground">({group.skills.length})</span>
              </h2>
              <ul className="space-y-2">
                {group.skills.map((skill) => (
                  <SkillRow key={skill.path} skill={skill} onSelect={skills.selectSkill} />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </>
  );
}
