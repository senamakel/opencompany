import { useCallback, useEffect, useRef, useState } from "react";
import { Mail, MoreHorizontal, Plus, Sparkles, UserPlus, Wallet } from "lucide-react";
import { toast } from "sonner";

import { listPeople, me as fetchMe, type Person } from "@/api/auth";
import type { OpenCompanyClient } from "@/api/client";
import { setInboxEnabled } from "@/api/inbox";
import { ApiError, type TeamMemberDto } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { emptyDraft, type AgentDraft, type AgentFieldKey } from "@/lib/agent";
import {
  addMemberFailure,
  addOutcome,
  reportAddMember,
  type MissedStep,
} from "@/lib/member-feedback";
import {
  fromDto,
  initials,
  newMember,
  TEAM_TONES,
  type TeamMember,
} from "@/lib/team";
import { cn } from "@/lib/utils";
import { AgentDetailView } from "@/views/team/AgentDetailView";
import { AgentFields } from "@/views/team/AgentFields";

interface Props {
  client: OpenCompanyClient;
  company: string | null;
  /**
   * The agent id in the hash (`#/team/<agentId>`), when one is addressed. The
   * detail view is a sub-page rather than a modal so an operator can link to an
   * agent, refresh onto it, and use Back (issue #264).
   */
  sub: string | null;
  /** Open an agent, or return to the roster with `null`. */
  onOpenAgent: (agentId: string | null) => void;
  /**
   * Bumped when first-run setup staffs the company, so this view re-reads a
   * roster that now has people on it (`docs/spec/runtime/company-setup.md`).
   */
  refreshKey?: number;
  /**
   * Reopen first-run setup. Rendered as an in-place prompt while the company has
   * nobody on it, so skipping the dialog is not a dead end.
   */
  onRunSetup?: () => void;
}

type Load = "loading" | "ready";

/** The company's agents — showcased and operator-definable. */
export function TeamView({
  client,
  company,
  sub,
  onOpenAgent,
  refreshKey,
  onRunSetup,
}: Props) {
  const [load, setLoad] = useState<Load>("loading");
  const [fromHost, setFromHost] = useState(false);
  /**
   * The host answered the roster read **and** answered with nobody
   * (`docs/spec/runtime/company-setup.md`).
   *
   * Distinct from `!fromHost`, which also covers a host with no `…/team` surface
   * at all. Only the first case is a company waiting to be set up; offering
   * setup on the second would open a dialog whose first call 404s.
   */
  const [hostEmpty, setHostEmpty] = useState(false);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  // Who set which cap. Only an admin may read the user directory, so this stays
  // empty for a member — and the attribution line degrades to "an admin"
  // rather than disappearing.
  const [people, setPeople] = useState<Person[]>([]);
  // The member whose budget dialog is open, if any.
  const [budgetFor, setBudgetFor] = useState<TeamMember | null>(null);

  /**
   * Hiding the budget controls from a non-admin is **courtesy, not enforcement**.
   * The host refuses the write with a 403 whatever this says; showing an
   * operator a control they cannot use is the only thing this prevents.
   */
  const loadViewer = useCallback(async () => {
    let admin = false;
    try {
      admin = (await fetchMe(client, company)).role === "admin";
    } catch {
      // No user plane on this host, or not signed in — treat as non-admin.
    }
    setIsAdmin(admin);
    if (!admin) {
      setPeople([]);
      return;
    }
    try {
      setPeople(await listPeople(client, company));
    } catch {
      // Attribution falls back to "an admin"; not worth a toast.
      setPeople([]);
    }
  }, [client, company]);

  /**
   * Give a teammate an inbox, or take it away, on the host — keyed by the
   * roster **agent id**, which is the `InboxStore` key the Inbox page reads and
   * the ingest webhook files mail under. Nothing is persisted client-side: if
   * the write fails the switch goes back, so the console never claims an inbox
   * the host doesn't have.
   *
   * Starter-team cards are locally-invented placeholders, not host records, so
   * their ids are not real inbox keys — refuse rather than file mail under one.
   */
  async function toggleMemberInbox(member: TeamMember) {
    if (!fromHost) {
      toast.error("Add this teammate to your company first — an inbox needs a saved teammate.");
      return;
    }
    const next = !member.inboxEnabled;
    const apply = (enabled: boolean) =>
      setMembers((ms) => ms.map((m) => (m.id === member.id ? { ...m, inboxEnabled: enabled } : m)));
    apply(next);
    try {
      await setInboxEnabled(client, company, member.id, next);
    } catch (error) {
      apply(!next);
      toast.error(
        error instanceof ApiError && error.status === 404
          ? "This host doesn't offer teammate inboxes yet."
          : error instanceof Error
            ? error.message
            : "Couldn't change the inbox.",
      );
    }
  }

  /**
   * Re-read the roster. Answers whether it landed.
   *
   * The catch below is right to show nobody, and wrong to stay silent about
   * after a write we know the host took: a failed read here does not leave a
   * stale list, it empties the one the operator is about to be congratulated
   * over. `addMember` is the only caller that looks at the answer; the effects
   * and the Back handler still fire and forget.
   */
  const boot = useCallback(async (): Promise<boolean> => {
    try {
      const roster = await client.listTeam(company);
      if (roster.length) {
        setMembers(roster.map(fromDto));
        setFromHost(true);
        setHostEmpty(false);
      } else {
        // NOT `starterTeam()`. The host answered, and answered with nobody — so
        // fabricating twelve agents here would put "Ops Lead", "Front Desk" and
        // ten more on screen that do not exist on the host, directly under a
        // prompt saying the company has no team. An honest empty state plus the
        // setup offer is the whole point of the flow
        // (`docs/spec/runtime/company-setup.md`).
        setMembers([]);
        setFromHost(false);
        setHostEmpty(true);
      }
      return true;
    } catch {
      // The roster read failed, so we never learned who is on this company.
      // Show nobody rather than a fabricated team: an operator cannot tell an
      // invented roster from a real one, and every action on a fake row fails.
      // NOT `hostEmpty` — that means "the host answered, with nobody".
      setMembers([]);
      setFromHost(false);
      setHostEmpty(false);
      return false;
    } finally {
      setLoad("ready");
    }
  }, [client, company]);

  useEffect(() => {
    setLoad("loading");
    void boot();
    void loadViewer();
    // `refreshKey` re-runs the read after setup staffs the company; without it
    // the operator lands on the roster they had before their team was built.
  }, [boot, loadViewer, refreshKey]);

  /**
   * Re-read the roster on the way back from the agent sub-page (issue #264).
   *
   * This view renders the detail as an early return, so opening an agent never
   * unmounts the roster and never re-runs `boot`. An edit saved in the panel
   * therefore landed on the host while these cards went on showing what they
   * held before it: press Back after renaming an agent and the old role is
   * still on the card, until a hard reload. The panel and the roster disagreed
   * about the same company, and the roster was the wrong one.
   *
   * Keyed on `sub` rather than on the Back button's callback, so the browser's
   * own Back — and a hand-edited hash — refresh too. The ref is what keeps the
   * first mount from fetching twice: the effect above already did.
   */
  const leftAgentPage = useRef(false);
  useEffect(() => {
    if (sub) {
      leftAgentPage.current = true;
      return;
    }
    if (!leftAgentPage.current) return;
    leftAgentPage.current = false;
    // Deliberately without `setLoad("loading")`: the cards on screen are the
    // right cards, only possibly stale, so they stay put until the new ones
    // land rather than blanking to a skeleton on every Back.
    void boot();
  }, [sub, boot]);

  /** A human label for whoever set a cap — never a raw user id. */
  function whoSet(userId: string): string {
    const person = people.find((p) => p.id === userId);
    return person?.displayName?.trim() || person?.email || "an admin";
  }

  /**
   * Set, change, or remove a teammate's daily cap.
   *
   * `cap` is `null` to remove the cap and a number to set one — `0` included,
   * which caps the teammate at nothing. The two are different states on the host
   * and must stay different here, which is why this takes `number | null` and
   * never an optional.
   */
  async function applyBudget(member: TeamMember, cap: number | null) {
    try {
      const row = await client.setTeamBudget(member.id, cap, company);
      // Update the one card from the host's answer rather than refetching the
      // roster: the response IS the new state, so a refetch could only disagree.
      setMembers((ms) => ms.map((m) => (m.id === member.id ? { ...m, ...fromDto(row) } : m)));
      toast.success(cap === null ? "Daily cap removed." : `Daily cap set to $${cap.toFixed(2)}.`);
    } catch (error) {
      toast.error(budgetError(error, "Couldn't change the daily cap."));
    }
  }

  /** Drop the override so the company's own default applies again. */
  async function resetBudget(member: TeamMember) {
    try {
      const row = await client.clearTeamBudgetOverride(member.id, company);
      setMembers((ms) => ms.map((m) => (m.id === member.id ? { ...m, ...fromDto(row) } : m)));
      toast.success("Reset to the company default.");
    } catch (error) {
      toast.error(budgetError(error, "Couldn't reset the daily cap."));
    }
  }

  async function addMember(fields: AddMemberFields) {
    let created: TeamMemberDto | null = null;
    try {
      created = await client.addTeamMember(
        {
          name: fields.name,
          role: fields.role,
          description: fields.description || undefined,
          // Omitted unless the operator typed one: an add that carries a cap is
          // admin-only on the host, while a plain add is open to any member.
          budgetUsdDaily: fields.budgetUsdDaily,
        },
        company,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // No team write plane on this host — keep the edit local-only. An inbox
        // needs a persisted teammate to hang off, so it can't be enabled here.
        setMembers((m) => [...m, newMember(fields)]);
        reportAddMember({
          kind: "console-only",
          name: fields.name,
          note: fields.inbox ? "No inbox was created." : undefined,
        });
        setAddOpen(false);
        return;
      }
      reportAddMember(addMemberFailure(error));
      return;
    }

    const missed: MissedStep[] = [];
    // Enable the inbox against the host's real agent id *before* refetching, so
    // the reloaded roster already reports the toggle as on.
    if (fields.inbox) {
      try {
        await setInboxEnabled(client, company, created.id, true);
      } catch {
        missed.push({
          what: "their inbox couldn't be switched on",
          fix: "Turn it on from their actions menu.",
        });
      }
    }
    // Persisted on the host — refetch so the card reflects the real record
    // (id, merge order, inbox state) rather than a locally-guessed one.
    if (!(await boot())) {
      missed.push({
        what: "the roster couldn't be read back",
        fix: "The roster below is empty because that read failed, not because your company is — reload to see them.",
      });
    }
    setAddOpen(false);
    // Announced after the refetch, not on the response, and only as a clean add
    // when that refetch actually landed: the roster the operator is looking at
    // is the one being claimed about, so a read that could not confirm the
    // write must not be toasted over as though it had.
    reportAddMember(addOutcome(fields.name, missed));
  }

  async function removeMember(member: TeamMember) {
    try {
      await client.removeTeamMember(member.id, company);
      await boot();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // No team write plane on this host — drop it from local state only.
        setMembers((ms) => ms.filter((x) => x.id !== member.id));
      } else if (error instanceof ApiError && error.status === 409) {
        toast.error("This teammate is defined in the company manifest and can't be removed here.");
      } else {
        toast.error(error instanceof Error ? error.message : "Couldn't remove teammate.");
      }
    }
  }

  // `#/team/<agentId>` is the agent detail sub-page. Every hook above has
  // already run, so this early return keeps hook order stable across both
  // shapes of the view.
  if (sub) {
    return (
      <AgentDetailView
        client={client}
        company={company}
        agentId={sub}
        onBack={() => onOpenAgent(null)}
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-2xl font-semibold tracking-tight">Team</h2>
            <p className="text-sm text-muted-foreground">
              The teammates that make up your company. {fromHost ? "Defined by this company." : "Start from these and shape your own."}
            </p>
          </div>
          <Button onClick={() => setAddOpen(true)}>
            <UserPlus className="size-4" /> Add teammate
          </Button>
        </div>

        {/*
          The other half of "blocking but skippable": while nobody is on this
          company, keep a visible way back into setup. Skipping the dialog leaves
          an operator on an empty page, and burying the offer would make that a
          dead end. Gated on `fromHost` too, so the pre-connection fabricated
          starter roster — which is not a real team — cannot hide the prompt.
        */}
        {load === "ready" && onRunSetup && hostEmpty && (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed px-4 py-3"
            data-testid="setup-prompt"
          >
            <div className="space-y-0.5">
              <p className="text-sm font-medium">This company has no team yet</p>
              <p className="text-sm text-muted-foreground">
                Answer three questions and we'll build you a starting team.
              </p>
            </div>
            <Button variant="secondary" onClick={onRunSetup} data-testid="setup-prompt-run">
              <Sparkles className="size-4" /> Set up my company
            </Button>
          </div>
        )}

        {load === "loading" ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-32 rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {members.map((m) => (
              <MemberCard
                key={m.id}
                member={m}
                inboxOn={m.inboxEnabled}
                onToggleInbox={() => void toggleMemberInbox(m)}
                onRemove={() => void removeMember(m)}
                // Only a host-backed teammate can be opened: a starter-team
                // card is a local placeholder with no record behind it, so its
                // id would 404 and the detail view would report a teammate that
                // was never removed.
                onOpen={fromHost ? () => onOpenAgent(m.id) : undefined}
                // Budget edits need a teammate the host actually knows about;
                // starter-team cards are local placeholders with no record.
                canEditBudget={isAdmin && fromHost}
                onEditBudget={() => setBudgetFor(m)}
                onRemoveCap={() => void applyBudget(m, null)}
                onResetBudget={() => void resetBudget(m)}
                setByLabel={m.budgetSetBy ? whoSet(m.budgetSetBy) : undefined}
              />
            ))}
            <button
              onClick={() => setAddOpen(true)}
              className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent/40 hover:text-foreground"
            >
              <Plus className="size-5" />
              Define a teammate
            </button>
          </div>
        )}
      </div>

      <AddMemberDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdd={addMember}
        canSetBudget={isAdmin && fromHost}
      />
      <BudgetDialog
        member={budgetFor}
        onOpenChange={(open) => {
          if (!open) setBudgetFor(null);
        }}
        onSave={(cap) => {
          const target = budgetFor;
          setBudgetFor(null);
          if (target) void applyBudget(target, cap);
        }}
      />
    </div>
  );
}

/** The fields the add dialog collects. */
interface AddMemberFields {
  name: string;
  role: string;
  description: string;
  inbox?: boolean;
  /** An optional daily cap. Undefined means "don't set one", never "$0". */
  budgetUsdDaily?: number;
}

/**
 * Turns a failed budget write into something worth reading.
 *
 * The 403 is the one an operator will actually hit, and it needs to say *why* —
 * "only an admin can change a spend limit" is the answer, not "request failed".
 */
function budgetError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Only an admin can change a teammate's daily cap.";
    if (error.status === 404) return "This host doesn't support console budgets yet.";
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

function MemberCard({
  member,
  inboxOn,
  onToggleInbox,
  onRemove,
  onOpen,
  canEditBudget,
  onEditBudget,
  onRemoveCap,
  onResetBudget,
  setByLabel,
}: {
  member: TeamMember;
  inboxOn: boolean;
  onToggleInbox: () => void;
  onRemove: () => void;
  /** Open this agent's detail page. Undefined when the card has no host record. */
  onOpen?: () => void;
  /** Whether to offer the budget controls at all (admins, host-backed cards). */
  canEditBudget: boolean;
  onEditBudget: () => void;
  onRemoveCap: () => void;
  onResetBudget: () => void;
  /** Who set the current override, already resolved to something readable. */
  setByLabel?: string;
}) {
  const capped = member.budgetUsdDaily !== undefined;
  // An override exists (someone set this deliberately), as opposed to the cap
  // simply coming from the company's own definition.
  const overridden = member.budgetSetBy !== undefined;
  return (
    <Card data-testid="team-card">
      <CardContent className="flex h-full flex-col gap-3 py-4">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-xl text-sm font-semibold",
              TEAM_TONES[member.tone] ?? "bg-muted text-muted-foreground",
            )}
            aria-hidden
          >
            {initials(member.name)}
          </div>
          {onOpen ? (
            // The card's own name is the way in (issue #264). A whole-card
            // click would swallow the inbox switch and the actions menu, both
            // of which live inside it, so the target is deliberately this
            // block rather than the card.
            <button
              onClick={onOpen}
              className="min-w-0 flex-1 rounded-md text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="team-card-open"
            >
              <p className="truncate font-medium">{member.name}</p>
              <p className="truncate text-xs text-muted-foreground">{member.role}</p>
            </button>
          ) : (
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{member.name}</p>
              <p className="truncate text-xs text-muted-foreground">{member.role}</p>
            </div>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" className="-mr-1 -mt-1 size-7" aria-label="Teammate actions" />}
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onOpen && (
                <>
                  <DropdownMenuItem onClick={onOpen} data-testid="team-open-agent">
                    View teammate
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {canEditBudget && (
                <>
                  <DropdownMenuItem onClick={onEditBudget} data-testid="team-budget-edit">
                    <Wallet className="size-4" />
                    {capped ? "Change daily budget…" : "Set daily budget…"}
                  </DropdownMenuItem>
                  {capped && (
                    <DropdownMenuItem onClick={onRemoveCap} data-testid="team-budget-remove">
                      Remove cap
                    </DropdownMenuItem>
                  )}
                  {overridden && (
                    <DropdownMenuItem onClick={onResetBudget} data-testid="team-budget-reset">
                      Reset to company default
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem variant="destructive" onClick={onRemove}>
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {member.description && (
          <p className="line-clamp-3 text-sm text-muted-foreground">{member.description}</p>
        )}
        <DailyBudgetLine member={member} setByLabel={setByLabel} />
        <div className="mt-auto flex items-center justify-between gap-2 border-t pt-3">
          <Badge variant="secondary" className="gap-1">
            <Sparkles className="size-3" /> Teammate
          </Badge>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Mail className="size-3.5" />
            Inbox
            <Switch
              checked={inboxOn}
              onCheckedChange={onToggleInbox}
              aria-label="Give this teammate an inbox"
              data-testid="team-inbox-toggle"
            />
          </label>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The teammate's daily spend cap and what it has spent against it today.
 *
 * Renders nothing at all for an uncapped teammate: the host omits the fields
 * entirely rather than sending zeros, so absence means "spends freely" and must
 * not be drawn as "$0.00/day". Once spend reaches the cap the line turns
 * destructive — that teammate's dispatch is paused until 00:00 UTC, and the
 * card is where an operator will look to find out why it went quiet.
 */
function DailyBudgetLine({
  member,
  setByLabel,
}: {
  member: TeamMember;
  setByLabel?: string;
}) {
  const cap = member.budgetUsdDaily;
  const attribution =
    setByLabel && member.budgetSetAtMillis !== undefined ? (
      <p data-testid="team-budget-attribution" className="text-xs text-muted-foreground">
        {cap === undefined ? "Uncapped by" : "Set by"} {setByLabel} ·{" "}
        {new Date(member.budgetSetAtMillis).toLocaleDateString()}
      </p>
    ) : null;

  // No cap: render nothing but the attribution, if a human deliberately removed
  // one. "Uncapped by Ana" and "nobody ever capped this" are different facts,
  // and only the first has a line.
  if (cap === undefined) return attribution;

  const spent = member.spentTodayUsd ?? 0;
  const overBudget = spent >= cap;
  const usd = (n: number) => `$${n.toFixed(2)}`;
  return (
    <div className="space-y-0.5">
      <p
        data-testid="team-budget"
        className={cn("text-xs", overBudget ? "text-destructive" : "text-muted-foreground")}
      >
        {usd(cap)}/day · {usd(spent)} spent today
        {overBudget && " · paused until 00:00 UTC"}
      </p>
      {attribution}
    </div>
  );
}

/**
 * Enter a daily cap for one teammate.
 *
 * Empty input is **not** submittable: "no cap" is the explicit "Remove cap"
 * action on the card, not a blank field, so an operator clearing the box and
 * saving can never silently uncap a teammate. `0` is allowed and means exactly
 * what it says — this teammate may not spend.
 */
function BudgetDialog({
  member,
  onOpenChange,
  onSave,
}: {
  member: TeamMember | null;
  onOpenChange: (open: boolean) => void;
  onSave: (cap: number) => void;
}) {
  const [value, setValue] = useState("");

  useEffect(() => {
    setValue(member?.budgetUsdDaily !== undefined ? String(member.budgetUsdDaily) : "");
  }, [member]);

  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;

  return (
    <Dialog open={member !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Daily budget</DialogTitle>
          <DialogDescription>
            The most {member?.name ?? "this teammate"} may spend per day. It takes effect on their
            next task — no restart needed.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="member-budget">US dollars per day</Label>
          <Input
            id="member-budget"
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. 5.00"
            data-testid="team-budget-input"
          />
          <p className="text-xs text-muted-foreground">
            $0 stops them spending entirely. To let them spend freely, use “Remove cap”.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => valid && onSave(parsed)}
            disabled={!valid}
            data-testid="team-budget-save"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddMemberDialog({
  open,
  onOpenChange,
  onAdd,
  canSetBudget,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdd: (fields: AddMemberFields) => void;
  /** Whether to offer the cap field — setting one is admin-only on the host. */
  canSetBudget: boolean;
}) {
  // The same three authored fields the detail view edits, held in the same
  // shape (issue #264) so "Define a teammate" and "Edit teammate" cannot drift into
  // two different sets of labels for one set of values.
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft);
  const [inbox, setInbox] = useState(false);
  const [budget, setBudget] = useState("");

  function reset() {
    setDraft(emptyDraft());
    setInbox(false);
    setBudget("");
  }

  const parsedBudget = Number(budget);
  // A blank field means "no cap", which is the default for a new teammate —
  // so it is left out of the request entirely rather than sent as 0.
  const budgetUsdDaily =
    budget.trim() !== "" && Number.isFinite(parsedBudget) && parsedBudget >= 0
      ? parsedBudget
      : undefined;
  const budgetInvalid = budget.trim() !== "" && budgetUsdDaily === undefined;

  function submit() {
    if (!draft.name.trim() || !draft.role.trim() || budgetInvalid) return;
    onAdd({
      name: draft.name,
      role: draft.role,
      description: draft.description,
      inbox,
      budgetUsdDaily,
    });
    reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Define a teammate</DialogTitle>
          <DialogDescription>Add a teammate to your company&apos;s roster.</DialogDescription>
        </DialogHeader>
        <AgentFields
          idPrefix="member"
          draft={draft}
          onChange={(key: AgentFieldKey, value) => setDraft((d) => ({ ...d, [key]: value }))}
        />
        {canSetBudget && (
          <div className="grid gap-2">
            <Label htmlFor="member-budget-new">Daily budget (optional)</Label>
            <Input
              id="member-budget-new"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="e.g. 5.00 — leave blank for no cap"
              data-testid="team-add-budget"
            />
          </div>
        )}
        <label className="flex items-center justify-between rounded-lg border p-3">
          <span className="flex items-center gap-2 text-sm">
            <Mail className="size-4 text-muted-foreground" /> Give this teammate an inbox
          </span>
          <Switch checked={inbox} onCheckedChange={setInbox} aria-label="Give this teammate an inbox" />
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!draft.name.trim() || !draft.role.trim() || budgetInvalid}
          >
            Add teammate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
