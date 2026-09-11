// What needs you, and what happened to you — one page, two tabs.
//
// # Why these two are one page
//
// The test `page-tabs.tsx` sets for reaching for a tab rather than a sub-page
// is: *would a row for each be a lie about how many things the page is?* An
// approval waiting on a verdict and a dispatch that failed are the same
// question asked twice — "what wants my attention?" — answered from two stores
// because of how they are produced, not because they are two subjects. An
// operator opening a bell is not choosing between them; they are checking
// whether anything is there.
//
// Only one of the two was ever reachable. Approvals was a sidebar row; the
// notification feed had no rendered surface at all (see `ActivityTab`). So this
// page is not a reorganisation of two existing screens — it is one screen
// gaining a second half.
//
// # The Approvals tab is `ApprovalsView`, unchanged
//
// Deliberately the same component the sidebar row rendered, with the same
// props, not a copy adapted for a tab. The queue carries a great deal of
// behaviour that has been fixed one issue at a time — per-approval in-flight
// state (#373), the honest verdict on a lost connection (#380), the
// decided-by-this-tab guard against an SSE echo (#1211), standing permissions
// ahead of the backlog (#1427), the one-card filter (#883) — and every one of
// those would have to be re-derived in a fork. The only thing that changed in
// it is the heading: this page owns the `h1` now, so the view's own `hidden`
// `PageHeader` went rather than becoming a second one.
//
// # Two heads, one page
//
// `#/notifications` is the address, and `?tab=` carries which half you are
// looking at. `#/approvals` and `#/approvals/<taskId>` still answer, because
// `REWRITE_RETIRED` maps `[head, sub] -> [View, sub]` with no query channel and
// so could not have carried a task id across — see `lib/console-routes.ts`.
// The shell hands this page `forceApprovalsTab` for that head and forwards the
// second segment as `sub`, so every link ever minted at the queue lands on the
// queue, narrowed exactly as it was.

import { useCallback, useMemo } from "react";
import { Bell, ShieldCheck } from "lucide-react";

import type { OpenCompanyClient } from "@/api/client";
import type { NotificationDto } from "@/api/types";
import { PageHeader } from "@/components/page-header";
import { PageTabs, pageTabIds, type PageTab } from "@/components/page-tabs";
import type { CompanyFeed } from "@/hooks/use-company";
import { useHashTab } from "@/hooks/use-hash-tab";
import { ApprovalsView } from "@/views/ApprovalsView";
import { ActivityTab } from "@/views/notifications/ActivityTab";

type NotificationTab = "approvals" | "activity";

/** `?tab=` values, in strip order. */
const TAB_IDS: readonly NotificationTab[] = ["approvals", "activity"];

const ID_BASE = "notifications";

export function NotificationsView({
  client,
  company,
  feed,
  sub,
  notifications,
  channels,
  onNotificationsRead,
  forceApprovalsTab = false,
  onResolved,
  onGoToConversation,
  chatChannelByThread,
  onDecideStart,
}: {
  client: OpenCompanyClient;
  company: string | null;
  feed: CompanyFeed;
  /** `#/approvals/<taskId>` — forwarded to the queue untouched (issue #883). */
  sub?: string | null;
  /** The shell's polled notification feed. Unread rows only, per the host. */
  notifications: readonly NotificationDto[];
  channels: { rendered: ReadonlySet<string>; mainChannelId: string | undefined };
  /**
   * Mark rows read.
   *
   * `ids` absent means **everything this person can see** — that is what the
   * host's `PUT` does with no `ids` field, and what "Dismiss all" means. An
   * explicitly empty array marks nothing, which is a real distinction and not
   * one this page ever wants: it must never send `[]` expecting a refresh.
   *
   * Returns when the write is over, so `ActivityTab` can stop hiding a row it
   * optimistically removed. A caller with nothing to await may return nothing.
   */
  onNotificationsRead: (ids?: readonly string[]) => void | Promise<void>;
  /** `#/approvals` forces the queue and ignores `?tab=`. */
  forceApprovalsTab?: boolean;
  onResolved: (systemLine: string) => void;
  onGoToConversation: () => void;
  chatChannelByThread?: Readonly<Record<string, string>>;
  onDecideStart?: (approvalId: string) => void;
}) {
  // Unconditional, always, whichever head routed here: a hook behind a
  // condition is a different hook order on the next render. Only its *result*
  // is overridden below.
  const [hashTab, setHashTab] = useHashTab(TAB_IDS, "approvals");
  const tab: NotificationTab = forceApprovalsTab ? "approvals" : hashTab;

  const unread = useMemo(
    () => notifications.filter((n) => n.readAt === undefined).length,
    [notifications],
  );

  const tabs: readonly PageTab<NotificationTab>[] = useMemo(
    () => [
      {
        id: "approvals",
        label: "Approvals",
        icon: ShieldCheck,
        // `feed.status.pending_approvals`, the same single value the title
        // row's bell prints. Never recounted here (#932).
        count: feed.status.pending_approvals || undefined,
      },
      {
        id: "activity",
        label: "Activity",
        icon: Bell,
        count: unread || undefined,
        hint: "Unread notifications — mentions, failed dispatches, expired approvals",
      },
    ],
    [feed.status.pending_approvals, unread],
  );

  /**
   * Selecting a tab, from either head.
   *
   * On `#/notifications` this is the hash setter and nothing more. On the
   * legacy `#/approvals` head it cannot be: `tab` is forced to `"approvals"`
   * there, so writing `?tab=activity` onto that hash changes the address and
   * leaves the queue on screen — the operator clicks Activity, the URL moves
   * and the page does not (Codex). Moving to the page's own address is what
   * actually selects the tab.
   *
   * Only the move *away* redirects. Clicking Approvals on the forced head
   * would otherwise navigate off `#/approvals/<taskId>` and drop the task id,
   * which is the one thing that head exists to carry (#883).
   */
  const selectTab = useCallback(
    (next: NotificationTab) => {
      if (!forceApprovalsTab) {
        setHashTab(next);
        return;
      }
      if (next === "approvals") return;
      // `?host=` and anything else riding the address survives the move — the
      // same rule `useHashTab`'s own setter follows.
      const [, query = ""] = window.location.hash.split("?");
      const params = new URLSearchParams(query);
      params.set("tab", next);
      const qs = params.toString().replace(/=(?=&|$)/g, "");
      window.location.hash = `#/notifications${qs ? `?${qs}` : ""}`;
    },
    [forceApprovalsTab, setHashTab],
  );

  const dismiss = useCallback(
    (id: string) => onNotificationsRead([id]),
    [onNotificationsRead],
  );
  const dismissAll = useCallback(() => onNotificationsRead(), [onNotificationsRead]);

  const ids = pageTabIds(ID_BASE, tab);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Notifications"
        width="full"
        description="What is waiting on a decision from you, and what your company has told you since you last looked."
        tabs={
          <PageTabs
            tabs={tabs}
            value={tab}
            onChange={selectTab}
            idBase={ID_BASE}
            aria-label="Notification views"
          />
        }
      />
      {tab === "approvals" ? (
        // No wrapper padding: `ApprovalsView` owns its own scroll container and
        // gutter (`flex-1 overflow-y-auto` over `w-full px-4 py-6`), which is
        // exactly what this column expects below a `PageHeader`. `min-h-0` on
        // the column above is what lets it scroll inside the page instead of
        // pushing the page past the viewport.
        <div
          role="tabpanel"
          id={ids.panel}
          aria-labelledby={ids.tab}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ApprovalsView
            client={client}
            company={company}
            feed={feed}
            sub={sub}
            chatChannelByThread={chatChannelByThread}
            onResolved={onResolved}
            onGoToConversation={onGoToConversation}
            onDecideStart={onDecideStart}
          />
        </div>
      ) : (
        <div
          role="tabpanel"
          id={ids.panel}
          aria-labelledby={ids.tab}
          className="flex-1 overflow-y-auto"
        >
          <div className="w-full px-4 py-6">
            <ActivityTab
              notifications={notifications}
              now={feed.now}
              channels={channels}
              onDismiss={dismiss}
              onDismissAll={dismissAll}
            />
          </div>
        </div>
      )}
    </div>
  );
}
