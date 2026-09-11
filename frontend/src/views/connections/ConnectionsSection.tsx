import type { OpenCompanyClient } from "@/api/client";
import { resolveConnectionPage } from "@/views/connection-pages";
import { ApiKeyView } from "@/views/connections/ApiKeyView";
import { ComposioView } from "@/views/connections/ComposioView";
import { HostingView } from "@/views/HostingView";
import { InferenceView } from "@/views/InferenceView";
import { McpServersView } from "@/views/McpServersView";
import { OAuthView } from "@/views/OAuthView";
import { SearchView } from "@/views/SearchView";
import { SkillsView } from "@/views/SkillsView";

interface Props {
  client: OpenCompanyClient;
  company: string | null;
  /** The hash's second segment, e.g. `mcp` in `#/connections/mcp`. */
  sub: string | null;
}

/**
 * Connections, as a section rather than two settings tabs.
 *
 * # Why this replaced Settings → OAuth and Settings → MCP Servers
 *
 * The same argument `docs/spec/runtime/finance-console.md` makes about Billing.
 * Settings is where an operator changes how the company is configured — a place
 * they visit once, on the way to something else. Which apps the company can act
 * through, and which tool servers its teammates can call, is not that: it is
 * read repeatedly, it changes as the company's work changes, and an operator
 * arrives at it asking "can my teammates do X yet?" rather than "what is this
 * company's configuration?". Two clicks down a settings rail is the wrong depth
 * for a question asked that often.
 *
 * # This is not a revert of the Connections split
 *
 * A single "Connections" **page** once carried five subjects and was broken
 * apart on purpose. Nothing here puts them back on one page: every entry in
 * `CONNECTION_PAGES` is still one page answering one question. What they gain
 * is a parent, which is what the original split had no room to give them.
 *
 * Inference, Skills, Hosting and Search have since joined Apps and MCP Servers
 * under that parent, and the settings rail they left is down to who can sign
 * in, how the company behaves, what it did and what it spends. The argument
 * for each move — and for why "a credential form belongs beside what it
 * unlocks" turned out to point *here* rather than away — is on
 * `CONNECTION_PAGES` in `views/connection-pages.ts`.
 *
 * # Where the rail went, twice
 *
 * This section shipped with a 240px sub-rail of its own inside the content
 * area, modelled on `finance/FinanceSection.tsx` (PR #1977). It gave that up
 * for rows in the sidebar under its own section row, on the argument that a
 * per-section rail puts the same kind of list in two different places and
 * charges the content pane 240px on a screen that already has a sidebar.
 *
 * Sub-navigation is a content rail again (issue #2130) — but the **shared** one,
 * `components/section-rail.tsx`, built from the same `NAV_SECTIONS` table every
 * section reads, because the sidebar's middle region is the Room channel list
 * now and is pinned there on every section. The reversal and what it is worth
 * are argued on `NAV_SECTIONS` in `components/sidebar-navigation.tsx`; the
 * "two different places" half of the old argument is answered by there being
 * exactly one rail implementation and never two rails on screen.
 *
 * This file is unchanged by either move, and that is the point worth keeping:
 * what is left is the dispatch, which is all this component ever did besides
 * draw a rail. Every view under it is re-parented, not rewritten.
 * The one content change was `OAuthView`'s title: the page is called **Apps**
 * now, because "OAuth" names the protocol a connection happens to use rather
 * than the thing an operator came to find, and under a section already named
 * Connections it said the same word twice.
 */
export function ConnectionsSection({ client, company, sub }: Props) {
  const page = resolveConnectionPage(sub);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Remounted per company, the same rule `SkillsView`/`HostingView` below
          apply: React otherwise preserves `status`, `billing` and `canManage`
          from the previous company until the new requests resolve, so the
          page can briefly show the previous company's balance, account links
          and credential controls under the new company's name. */}
      {page === "api-key" && (
        <ApiKeyView key={company ?? "self"} client={client} company={company} />
      )}
      {page === "apps" && <OAuthView client={client} company={company} />}
      {/* Remounted per company for the reason every credential page on this
          rail is: a key typed for one company must never ride into another
          company's Save. */}
      {page === "composio" && (
        <ComposioView key={company ?? "self"} client={client} company={company} />
      )}
      {page === "mcp" && <McpServersView client={client} company={company} />}
      {page === "inference" && <InferenceView client={client} company={company} />}
      {/* Remounted per company, the same rule `SettingsSection` applied while
          this page lived on its rail: `canManage` and the Add dialog's draft
          must not carry one company's admin authority into another's
          still-resolving read. */}
      {page === "skills" && <SkillsView key={company ?? "self"} client={client} company={company} />}
      {/* Both remounted per company for the reason they were on the settings
          rail: a deploy token or a search key typed for one company must never
          ride into another company's Save. */}
      {page === "hosting" && (
        <HostingView key={company ?? "self"} client={client} company={company} />
      )}
      {page === "search" && (
        <SearchView key={company ?? "self"} client={client} company={company} />
      )}
    </div>
  );
}
