// The company org chart (issue #311): the surface that replaces the removed
// Desks page rather than restoring it.
//
// #302 closed the way in to desk management and said so plainly — "desk
// creation and membership editing become unreachable ... editable by hand in
// the manifest and nowhere else" — and accepted that as temporary. This is the
// destination. Creation, deletion, membership and the lead are all routed
// through the hierarchy, so there is one structure surface and not a flat list
// beside it.
//
// The tree is three levels — company, desk, seat — and that cap is structural,
// not checked: see `lib/org.ts`. The DOM says so too. Every node carries an
// `aria-level`, and no code path here can emit `aria-level="4"`, which is what
// the e2e spec asserts.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Crown,
  Plus,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { listPeople } from "@/api/auth";
import type { OpenCompanyClient } from "@/api/client";
import { ApiError, type DeskDto, type TeamMemberDto } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  addMemberFailure,
  addOutcome,
  NO_TEAM_WRITE_PLANE,
  reportAddMember,
  type AddMemberOutcome,
  type MissedStep,
} from "@/lib/member-feedback";
import {
  addableTo,
  buildOrgTree,
  reorderedIds,
  reorderedIdsAfterDrop,
  summarize,
  type OrgDesk,
  type OrgPerson,
  type OrgSeat,
  type OrgTree,
} from "@/lib/org";
import { cn } from "@/lib/utils";
import { DeskCreateDialog } from "@/views/company/DeskCreateDialog";
import {
  AddMemberDialog,
  type NewMemberFields,
} from "@/views/chat/AddMemberDialog";

const SEAT_MIME = "application/x-opencompany-seat";

/**
 * Where a teammate named on this chart opens: `#/team/<agentId>`, the sub-page
 * `TeamView` already routes to `AgentDetailView` (issue #1102).
 *
 * A **link**, not a click handler on a `div`. The console routes on the hash,
 * so an `<a href>` is the real address: middle-click and cmd-click open a
 * second console, the browser shows the target on hover, and the keyboard
 * reaches it without this file re-implementing Enter/Space and a focus ring.
 *
 * The id is the one the desk itself names — `OrgSeat.id` is `DeskDto.members[i]`
 * and `TeamMember.id` is the roster id, and `buildOrgTree` resolves the seat by
 * matching those two. That is exactly the id `AgentDetailView` asks the host
 * for, so no translation is needed here — and none should be invented.
 *
 * `null` for an id that is blank or missing, which is the whole point of
 * routing through this function: a teammate with no usable id must render as
 * plain text rather than as a link to `#/team/undefined`, which is a page that
 * cannot exist and would report the teammate as deleted.
 */
function teamHref(agentId: string | null | undefined): string | null {
  const id = agentId?.trim();
  return id ? `#/team/${encodeURIComponent(id)}` : null;
}

interface Props {
  client: OpenCompanyClient;
  company: string | null;
  /**
   * A desk to bring into view on arrival — the second segment of
   * `#/company/<deskId>`, which the chat member pane links to (issue #485).
   *
   * Best-effort on purpose. `useHashView` hands the segment back unvalidated,
   * this chart loads over the network, and a link outlives the desk it names —
   * so an id this chart does not draw is a **silent no-op**, never an error. A
   * stale bookmark should show the company, not a banner about it.
   *
   * The hash is never rewritten from here either: `#/company/<deskId>` is a
   * shareable address, and canonicalising it away would break the link the
   * operator just followed.
   */
  focusDeskId?: string | null;
}

type Load = "loading" | "ready" | "error";

export function OrgChartView({ client, company, focusDeskId }: Props) {
  const [load, setLoad] = useState<Load>("loading");
  const [tree, setTree] = useState<OrgTree | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [addMemberDeskId, setAddMemberDeskId] = useState<string | null>(null);
  // A generation token so a response for a company we have navigated away from
  // cannot overwrite the one on screen. Same guard `SkillsView` uses.
  const gen = useRef(0);
  /** Which desk id the arriving link has already been honoured for. */
  const focused = useRef<string | null>(null);
  /** The desk currently wearing the arrival ring, if any. */
  const [focusMark, setFocusMark] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);

  /**
   * Re-read the whole chart. Answers whether it landed.
   *
   * A read superseded by a newer one counts as landed: another `boot` owns the
   * screen and will settle it, so reporting a reload failure for it would warn
   * about a chart nobody is looking at. Only the catch is a real miss, and
   * `addMember` is the only caller that asks — everything else fires and
   * forgets, which is why this reports rather than rejects.
   */
  const boot = useCallback(async (): Promise<boolean> => {
    const mine = ++gen.current;
    try {
      // Desks are the only required half — they are the chart. The roster and
      // the people list are best-effort: a host that 404s `/team` still has a
      // structure worth drawing, it just cannot name who fills the seats, and
      // `buildOrgTree` marks those seats unknown rather than dropping them.
      const [desks, roster, people, status] = await Promise.all([
        client.listDesks(company) as Promise<DeskDto[]>,
        client.listTeam(company).catch(() => [] as TeamMemberDto[]),
        listPeople(client, company)
          .then((rows) =>
            rows.map((p): OrgPerson => ({
              id: p.id,
              name: p.displayName?.trim() || p.email.split("@")[0],
              email: p.email,
              role: p.role,
            })),
          )
          .catch(() => [] as OrgPerson[]),
        client.status(company).catch(() => null),
      ]);
      if (mine !== gen.current) return true;
      // Cleared here rather than at the top of the write that triggered this
      // read: since #1099 the banner belongs to the load alone, so a chart that
      // loads is the only thing that can retire the message saying it did not.
      setError(null);
      setTree(
        buildOrgTree(
          status?.name || company || "This company",
          desks,
          roster,
          people,
        ),
      );
      setLoad("ready");
      return true;
    } catch (e) {
      if (mine !== gen.current) return true;
      // A failed `/desks` is a real error, not an empty company. Inventing an
      // empty chart here would tell the operator their desks are gone.
      setError(
        e instanceof Error ? e.message : "Could not load the org chart.",
      );
      setLoad("error");
      return false;
    }
  }, [client, company]);

  useEffect(() => {
    setLoad("loading");
    void boot();
    return () => {
      gen.current++;
    };
  }, [boot]);

  /**
   * Bring the linked-to desk into view, once per id.
   *
   * Once, because every write here refetches the whole chart: re-running this
   * on each refetch would yank the page back to the linked desk while the
   * operator is editing a different one. `focused` records the id already
   * honoured rather than a boolean, so following a second link still works.
   *
   * The desk is also given DOM focus, not just a scroll position. A ring is
   * invisible to a screen reader, and "where did that link land me" is exactly
   * the question focus answers; `preventScroll` keeps `scrollIntoView`'s
   * centring rather than letting the browser re-scroll to its own idea of
   * visible.
   *
   * An id with no node — a deleted desk, a typo, a chart that 404'd — falls
   * through without marking itself honoured, so a desk that appears later
   * (created in another tab, or a refetch that finally succeeds) is still
   * caught.
   */
  /**
   * Forget the honoured id when the route target itself changes.
   *
   * `focused` exists to survive a *refetch* (same target, new tree), not a
   * *navigation*. Without this, leaving `#/company/<id>` for the bare chart or
   * a stale id and then coming back to the same desk hits the `focused.current
   * === focusDeskId` guard and the link silently does nothing the second time.
   * Clearing the mark here also stops an unknown target from inheriting the
   * previous desk's ring.
   *
   * Keyed on the target only — `tree` is deliberately absent, so a refetch
   * still cannot yank the operator back to the linked desk mid-edit.
   */
  useEffect(() => {
    focused.current = null;
    setFocusMark(null);
  }, [company, focusDeskId]);

  useEffect(() => {
    if (load !== "ready" || !focusDeskId || focused.current === focusDeskId)
      return;
    const node = chartRef.current?.querySelector<HTMLElement>(
      `[data-desk-id="${CSS.escape(focusDeskId)}"]`,
    );
    if (!node) return;
    focused.current = focusDeskId;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.focus({ preventScroll: true });
    setFocusMark(focusDeskId);
  }, [load, focusDeskId, tree]);

  /**
   * Drop the ring on the operator's first move, rather than after a guessed
   * number of milliseconds.
   *
   * A timer has to be picked against a chart that loads over the network: too
   * short and the ring expires before a slow load painted it, too long and it
   * outstays the moment it was drawn for. A click or a keypress is the actual
   * signal that the desk has been found.
   */
  useEffect(() => {
    if (!focusMark) return;
    const clear = () => setFocusMark(null);
    window.addEventListener("pointerdown", clear, { once: true });
    window.addEventListener("keydown", clear, { once: true });
    return () => {
      window.removeEventListener("pointerdown", clear);
      window.removeEventListener("keydown", clear);
    };
  }, [focusMark]);

  /**
   * Run a write, then re-read the whole chart.
   *
   * Refetch rather than patch in place: every write here changes something the
   * host derives (the effective member union, the lead, the overlay subset), so
   * a local edit would be a second implementation of rules the host already
   * owns — and the two would drift.
   */
  async function mutate(key: string, run: () => Promise<unknown>) {
    setBusy(key);
    try {
      await run();
      await boot();
    } catch (e) {
      // Toasted, not banked in the banner above the chart (issue #1099). The
      // banner is the page's own state — it belongs to a chart that could not
      // be *loaded*, and it sits with the Retry button that clears it. A write
      // the operator just attempted is an action, and every other action in
      // this console answers in a toast.
      toast.error(
        e instanceof Error ? e.message : "Something went wrong. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  /**
   * Company creation is durable structure, so a host without the team write
   * plane must explain the refusal rather than borrow ChatView's local-only
   * fallback. A local row could not be placed on a desk and would vanish on
   * the next chart read.
   */
  async function addMember(fields: NewMemberFields) {
    const deskId = addMemberDeskId;
    setBusy("add-member");
    // Whether the host has the teammate, which decides whether the chart needs
    // re-reading on the way out. A desk add that fails after the teammate is
    // created leaves the two disagreeing: the roster has someone the chart has
    // never heard of, so the message telling the operator to place them by hand
    // would point at a dropdown that does not list them yet.
    let createdOnHost = false;
    // What to say once the chart has been re-read — decided here, raised after
    // `boot()`, so a refetch that contradicts the write contradicts the message
    // too rather than arriving a beat behind it.
    let outcome: AddMemberOutcome;
    // Every step of the ask that did not land, in the order the operator met
    // them. Empty is the only thing that earns "Added <name>.".
    const missed: MissedStep[] = [];
    try {
      let created: TeamMemberDto;
      try {
        created = await client.addTeamMember(
          {
            name: fields.name,
            role: fields.role,
            description: fields.description || undefined,
          },
          company,
        );
        createdOnHost = true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          // No local-only fallback here, unlike the roster and the chat empty
          // state: a console-only teammate has no host id to place on a desk
          // and would vanish on the next chart read.
          throw new Error(
            `${NO_TEAM_WRITE_PLANE} They can't be created from the Company page.`,
          );
        }
        throw e;
      }
      if (deskId) {
        try {
          await client.addDeskMember(deskId, created.id, company);
        } catch (e) {
          // Created but unplaced — a real half-landing, and the operator has
          // to know which half, because the fix is on the chart in front of
          // them rather than in the dialog they just closed.
          missed.push({
            what: `they couldn't be added to that desk: ${e instanceof Error ? e.message : "unknown error"}`,
            fix: "They're on the roster — drag them onto the desk from the chart.",
          });
        }
      }
      if (!(await boot())) {
        // The chart is on its error state behind this toast. Congratulating the
        // operator over a banner saying the chart could not be loaded is the
        // contradiction #1099 set out to remove, not one to add.
        missed.push({
          what: "the chart couldn't be read back",
          fix: "Retry to see where they landed.",
        });
      }
      outcome = addOutcome(fields.name, missed);
      setAddMemberOpen(false);
    } catch (e) {
      setAddMemberOpen(false);
      outcome = addMemberFailure(e, "Could not create teammate.");
      if (createdOnHost) {
        await boot();
      }
    } finally {
      setBusy(null);
    }
    reportAddMember(outcome);
  }

  return (
    <div ref={chartRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-2xl font-semibold tracking-tight">Company</h2>
            <p className="text-sm text-muted-foreground">
              How your company is organised: the desks it works from and who
              staffs each one. Add a desk, move someone between desks, or change
              who leads.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={load === "loading"}
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="mr-1.5 size-4" />
              New desk
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={load === "loading"}
              onClick={() => {
                setAddMemberDeskId(null);
                setAddMemberOpen(true);
              }}
            >
              <UserPlus className="mr-1.5 size-4" />
              New teammate
            </Button>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {load === "loading" ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : load === "error" ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-sm text-muted-foreground">
            The org chart could not be loaded.
            <Button size="sm" variant="outline" onClick={() => void boot()}>
              Retry
            </Button>
          </div>
        ) : (
          tree && (
            <>
              <Chart
                tree={tree}
                busy={busy}
                focusMark={focusMark}
                onCreate={() => setCreateOpen(true)}
                onCreateMember={(desk) => {
                  setAddMemberDeskId(desk.id);
                  setAddMemberOpen(true);
                }}
                onAdd={(desk, agentId) =>
                  void mutate(`${desk.id}:${agentId}`, () =>
                    client.addDeskMember(desk.id, agentId, company),
                  )
                }
                onRemove={(desk, agentId) =>
                  void mutate(`${desk.id}:${agentId}`, () =>
                    client.removeDeskMember(desk.id, agentId, company),
                  )
                }
                onMove={(desk, index, direction) => {
                  const next = reorderedIds(desk, index, direction);
                  if (!next) return;
                  void mutate(`${desk.id}:${desk.seats[index].id}`, () =>
                    client.setDeskOrder(desk.id, next, company),
                  );
                }}
                onDrop={(desk, fromIndex, toIndex) => {
                  const next = reorderedIdsAfterDrop(desk, fromIndex, toIndex);
                  if (!next) return;
                  void mutate(`drag:${desk.id}`, () =>
                    client.setDeskOrder(desk.id, next, company),
                  );
                }}
                onDelete={(desk) =>
                  void mutate(`delete:${desk.id}`, () =>
                    client.deleteDesk(desk.id, company),
                  )
                }
              />
              <Unplaced tree={tree} />
            </>
          )
        )}
      </div>

      <DeskCreateDialog
        client={client}
        company={company}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => void boot()}
      />
      <AddMemberDialog
        open={addMemberOpen}
        onOpenChange={setAddMemberOpen}
        onAdd={(fields) => void addMember(fields)}
      />
    </div>
  );
}

/**
 * The tree proper.
 *
 * `role="tree"` with an explicit `aria-level` on every node, rather than nested
 * lists left to the reader: the level is the whole point of this surface, so it
 * is stated rather than implied by indentation a screen reader cannot see.
 */
function Chart({
  tree,
  busy,
  focusMark,
  onCreate,
  onCreateMember,
  onAdd,
  onRemove,
  onMove,
  onDrop,
  onDelete,
}: {
  tree: OrgTree;
  busy: string | null;
  /** The desk a `#/company/<deskId>` link landed on, ringed until first input. */
  focusMark: string | null;
  onCreate: () => void;
  onCreateMember: (desk: OrgDesk) => void;
  onAdd: (desk: OrgDesk, agentId: string) => void;
  onRemove: (desk: OrgDesk, agentId: string) => void;
  onMove: (desk: OrgDesk, index: number, direction: "up" | "down") => void;
  onDrop: (desk: OrgDesk, fromIndex: number, toIndex: number) => void;
  onDelete: (desk: OrgDesk) => void;
}) {
  return (
    <div role="tree" aria-label="Company org chart" className="space-y-3">
      <div
        role="treeitem"
        aria-level={1}
        aria-expanded="true"
        aria-selected="false"
      >
        <div className="rounded-xl border bg-muted/40 px-4 py-3">
          <p className="font-medium">{tree.companyName}</p>
          <p className="text-xs text-muted-foreground">{summarize(tree)}</p>
        </div>

        {tree.desks.length === 0 ? (
          <div className="mt-3 flex min-h-32 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-sm text-muted-foreground">
            <Users className="size-5" />
            This company has no desks yet.
            <Button size="sm" variant="outline" onClick={onCreate}>
              <Plus className="mr-1.5 size-4" />
              Create your first desk
            </Button>
          </div>
        ) : (
          <div role="group" className="mt-3 space-y-3 border-l pl-4">
            {tree.desks.map((desk) => (
              <DeskNode
                key={desk.id}
                desk={desk}
                addable={addableTo(tree, desk)}
                busy={busy}
                focused={focusMark === desk.id}
                onAdd={(agentId) => onAdd(desk, agentId)}
                onCreateMember={() => onCreateMember(desk)}
                onRemove={(agentId) => onRemove(desk, agentId)}
                onMove={(index, direction) => onMove(desk, index, direction)}
                onDrop={(fromIndex, toIndex) =>
                  onDrop(desk, fromIndex, toIndex)
                }
                onDelete={() => onDelete(desk)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One desk and its seats — levels 2 and 3. */
function DeskNode({
  desk,
  addable,
  busy,
  focused,
  onCreateMember,
  onAdd,
  onRemove,
  onMove,
  onDrop,
  onDelete,
}: {
  desk: OrgDesk;
  addable: { id: string; name: string }[];
  busy: string | null;
  /** This desk is the one a `#/company/<deskId>` link asked for. */
  focused: boolean;
  onCreateMember: () => void;
  onAdd: (agentId: string) => void;
  onRemove: (agentId: string) => void;
  onMove: (index: number, direction: "up" | "down") => void;
  onDrop: (fromIndex: number, toIndex: number) => void;
  onDelete: () => void;
}) {
  const locked = busy !== null;
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  return (
    <div
      role="treeitem"
      aria-level={2}
      aria-expanded="true"
      aria-selected="false"
      // The desk's anchor for `#/company/<deskId>` (issue #485). A data
      // attribute rather than an `id`: the desk id is the host's, and minting
      // document-wide ids from it would collide with anything else on the page
      // that names the same desk.
      data-desk-id={desk.id}
      data-desk-focused={focused ? "true" : undefined}
      // Programmatically focusable, not tab-reachable: the arrival focus is
      // how a screen reader is told where the link landed, but a desk wrapper
      // is not a control and does not belong in the tab order.
      tabIndex={-1}
      className={cn(
        "scroll-mt-4 rounded-xl outline-none",
        focused && "ring-2 ring-primary ring-offset-2 ring-offset-background",
      )}
    >
      <div className="rounded-xl border">
        <div className="flex items-start justify-between gap-2 px-3 py-2.5">
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate font-medium">
              {desk.name}
              {desk.provenance === "blueprint" && (
                <Badge variant="secondary" className="shrink-0 text-3xs">
                  Blueprint
                </Badge>
              )}
            </p>
            {desk.description && (
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {desk.description}
              </p>
            )}
          </div>
          {/* Only an operator-created desk can be deleted at runtime. A
              blueprint desk lives in version control, and the host refuses —
              so no button is offered rather than one that always fails. */}
          {desk.provenance === "overlay" && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={`Delete ${desk.name}`}
              disabled={locked}
              onClick={onDelete}
            >
              <Trash2
                className={cn(
                  "size-3.5",
                  busy === `delete:${desk.id}` && "opacity-50",
                )}
              />
            </Button>
          )}
        </div>

        <div role="group" className="space-y-1 border-t px-3 py-2">
          {desk.seats.length === 0 && (
            <p className="py-1 text-xs text-muted-foreground">
              Nobody staffs this desk yet.
            </p>
          )}
          {desk.seats.map((seat, index) => (
            <Seat
              key={seat.id}
              seat={seat}
              index={index}
              deskId={desk.id}
              deskName={desk.name}
              first={index === 0}
              last={index === desk.seats.length - 1}
              busy={busy === `${desk.id}:${seat.id}`}
              locked={locked}
              onUp={() => onMove(index, "up")}
              onDown={() => onMove(index, "down")}
              onRemove={() => onRemove(seat.id)}
              onDragStart={() => setDraggingIndex(index)}
              onDrop={(toIndex) => {
                if (draggingIndex !== null) onDrop(draggingIndex, toIndex);
                setDraggingIndex(null);
              }}
            />
          ))}

          <div className="flex items-center gap-1 pt-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-w-0 flex-1"
                    disabled={addable.length === 0 || locked}
                  />
                }
              >
                <Plus className="size-4" />
                {addable.length === 0
                  ? "Everyone is on this desk"
                  : "Add teammate"}
              </DropdownMenuTrigger>
              {addable.length > 0 && (
                <DropdownMenuContent
                  align="start"
                  className="max-h-64 overflow-y-auto"
                >
                  {addable.map((member) => (
                    <DropdownMenuItem
                      key={member.id}
                      onClick={() => onAdd(member.id)}
                    >
                      <span className="truncate">{member.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              )}
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={`Create teammate on ${desk.name}`}
              disabled={locked}
              onClick={onCreateMember}
            >
              <UserPlus className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One seat — level 3, the deepest a path here can go. */
function Seat({
  seat,
  index,
  deskId,
  deskName,
  first,
  last,
  busy,
  locked,
  onUp,
  onDown,
  onRemove,
  onDragStart,
  onDrop,
}: {
  seat: OrgSeat;
  index: number;
  deskId: string;
  deskName: string;
  first: boolean;
  last: boolean;
  busy: boolean;
  locked: boolean;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDrop: (toIndex: number) => void;
}) {
  function startDrag(event: DragEvent<HTMLDivElement>) {
    onDragStart();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(SEAT_MIME, `${deskId}:${index}`);
    event.dataTransfer.setData("text/plain", `${deskId}:${index}`);
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const payload =
      event.dataTransfer.getData(SEAT_MIME) ||
      event.dataTransfer.getData("text/plain");
    const [sourceDeskId, sourceIndex] = payload.split(":");
    const fromIndex = Number(sourceIndex);
    if (sourceDeskId === deskId && Number.isInteger(fromIndex)) onDrop(index);
  }

  // Where this seat opens, or `null` when it opens nowhere. A seat the roster
  // cannot resolve is deliberately *not* a link: `#/team/<id>` for an id the
  // host has never heard of lands on the detail view's "no such teammate"
  // state, so offering the link would send the operator to a dead end to
  // discover what the badge beside the name already says.
  const href = seat.known ? teamHref(seat.id) : null;

  const label = (
    <>
      {seat.lead && (
        <Crown
          role="img"
          aria-label="Desk lead"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      )}
      <span className={cn("truncate", !seat.known && "text-muted-foreground")}>
        {seat.name}
      </span>
      {seat.role && (
        <span className="truncate text-xs text-muted-foreground">
          {seat.role}
        </span>
      )}
      {/* A seat naming somebody the roster no longer has. Shown, not hidden:
          it is a fact about the structure only the operator can fix. */}
      {!seat.known && (
        <Badge variant="outline" className="shrink-0 text-3xs">
          Not on the roster
        </Badge>
      )}
    </>
  );

  return (
    <div
      role="treeitem"
      aria-level={3}
      aria-selected="false"
      draggable={!locked}
      data-seat-id={seat.id}
      onDragStart={startDrag}
      onDragOver={(event) => event.preventDefault()}
      onDrop={drop}
      className={cn(
        "flex cursor-grab items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-sm active:cursor-grabbing",
        busy && "opacity-50",
      )}
    >
      {href ? (
        <a
          href={href}
          title={`Open ${seat.name}`}
          // The name is the target, not the whole row: the row is the drag
          // handle for re-ordering, and a full-row link would make every
          // attempt to drag a seat read as a click on it.
          //
          // `draggable={false}` so a drag that starts on the name is not the
          // browser's own drag-a-link gesture — it falls through to the row,
          // which is the draggable ancestor, and re-ordering keeps working
          // from anywhere on the seat.
          draggable={false}
          className="-mx-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {label}
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        </a>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">{label}</span>
      )}
      <span className="flex shrink-0 items-center gap-0.5">
        {/* Moving the second seat up is how the lead changes: `members[0]` IS
            the lead, so there is no separate set-lead call to make. */}
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:text-foreground"
          aria-label={`Move ${seat.name} up in ${deskName}`}
          // Global lock, not per-row: any in-flight write means the order on
          // screen is about to be replaced, and a second PUT computed from it
          // would be built on a stale list.
          disabled={locked || first}
          onClick={onUp}
        >
          <ChevronUp className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:text-foreground"
          aria-label={`Move ${seat.name} down in ${deskName}`}
          disabled={locked || last}
          onClick={onDown}
        >
          <ChevronDown className="size-3.5" />
        </Button>
        {seat.provenance === "overlay" ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-destructive"
            aria-label={`Remove ${seat.name} from ${deskName}`}
            disabled={locked}
            onClick={onRemove}
          >
            <X className="size-3.5" />
          </Button>
        ) : (
          <Badge variant="secondary" className="shrink-0 text-3xs">
            Blueprint
          </Badge>
        )}
      </span>
    </div>
  );
}

/**
 * Everyone the chart does not place: roster teammates on no desk, and the
 * humans who can sign in.
 *
 * Outside the tree on purpose. Neither has a position the company declares, and
 * putting them under a node would be inventing structure — which is the failure
 * the Overview graph already documents about its own derived departments.
 */
function Unplaced({ tree }: { tree: OrgTree }) {
  if (tree.unassigned.length === 0 && tree.people.length === 0) return null;
  return (
    <div className="space-y-4">
      {tree.unassigned.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Not on a desk</h3>
          <p className="text-xs text-muted-foreground">
            Roster teammates the company has not staffed anywhere. Add them to a
            desk above.
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {tree.unassigned.map((member) => {
              // These chips name roster teammates, so they open the same page
              // a seat does (issue #1102) — they were the worse half of that
              // bug, bordered pills that read as controls and did nothing.
              const href = teamHref(member.id);
              return (
                <li key={member.id}>
                  {href ? (
                    <a
                      href={href}
                      title={`Open ${member.name}`}
                      className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {member.name}
                      <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                    </a>
                  ) : (
                    // No usable id, so there is nothing to open. Rendered flat
                    // rather than as a pill: the border is what made the inert
                    // version of this chip a lie.
                    <InertChip title="This teammate has no id, so their page can't be opened.">
                      {member.name}
                    </InertChip>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {tree.people.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">People</h3>
          <p className="text-xs text-muted-foreground">
            The humans who can sign in. Desks staff teammates, so the company
            declares no desk for a person, and this chart does not guess one.
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {/* Deliberately inert, and styled to say so (issue #1102). A person
                is a console user, not an agent: `#/team/<id>` resolves against
                the roster, so pointing a person's id at it would 404 every
                time. There is no person detail page to link to instead, so the
                pill treatment is dropped rather than left promising one. */}
            {tree.people.map((person) => (
              <li key={person.id}>
                <InertChip title="People sign in to the console. Desks staff agents, so a person has no teammate page.">
                  {person.name}
                  <span className="ml-1.5">{person.role}</span>
                </InertChip>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * A name that is only a name.
 *
 * Filled and borderless, with the muted foreground a caption uses: the outlined
 * pill it replaces was indistinguishable from an outline button, which is why
 * #1102 reports these as clicked and inert. Nothing here reacts to a pointer —
 * no hover, no cursor change, no focus ring — because nothing here happens.
 */
function InertChip({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className="inline-block rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
    >
      {children}
    </span>
  );
}
