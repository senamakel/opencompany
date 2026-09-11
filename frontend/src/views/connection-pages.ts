// The Connections section's sub-page table, and the helpers that read it.
//
// A leaf module, exactly as `settings-pages.ts` is, and for the same reason:
// anything *pointing at* a sub-page — prose, a route rewrite — has to name one
// without importing the section, which imports every view under it. The route
// rewrites in `lib/console-route-rewrites.ts` are the case that forces it here:
// they run on the router's own path, so a static import of the section from
// there would pull `OAuthView` and `McpServersView` in behind them.
//
// Modelled on `finance/FinanceSection.tsx`'s `FINANCE_PAGES`, which keeps its
// table inside the section because nothing outside needs to read it. This one
// is read from two other modules, so it lives on its own.

import {
  Blocks,
  BrainCircuit,
  Globe,
  KeyRound,
  KeySquare,
  LayoutGrid,
  Search,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

/**
 * The sub-pages that live under Connections. The id is the hash's second
 * segment.
 *
 * Six pages, not one. A single "Connections" page once carried third-party
 * accounts, MCP servers, inference, channels and repositories, and was
 * deliberately broken apart because each was something an operator scrolled
 * past on the way to another (see the comment above the `oauth` entry in
 * `settings-pages.ts`, and `OAuthView`'s own header). That decision was about
 * one-question-per-page, and it stands: every entry below is still one page
 * answering one question. What they gain is a parent, which is a different
 * thing from being merged back together.
 *
 * Inference and Skills join them here, and this file used to argue the
 * opposite: that a credential form belongs beside the one thing it unlocks, so
 * filing Inference under a section named for the act of connecting would
 * separate it from what it is for. What that argument missed is that Settings
 * is not "beside the model" either — it is a rail of configuration an operator
 * visits once, and the model a company thinks with is the single most-read,
 * most-changed thing on it. The test the section already applies to Apps and
 * MCP Servers ("read repeatedly, changes as the company's work changes, asked
 * as *can my teammates do X yet?*") is answered yes by both of these:
 *
 *   - **Inference** is what every teammate thinks with. A company with no model
 *     configured cannot answer a single message, and the chat pane's own
 *     "cannot reach a model" banner links straight here.
 *   - **Skills** are the playbooks teammates read. Installing one is the same
 *     act as connecting an app — granting the company a capability it did not
 *     have a minute ago — and it is checked far more often than it is set.
 *
 *   - **Hosting** and **Search** are the two remaining halves of the original
 *     five-subject Connections page, and they come back for the plainest
 *     reason of the lot: each names an outside service the company acts
 *     through — a deploy target, a search provider — which is what this
 *     section is for. Settings kept them on the argument that a credential
 *     form belongs beside what it unlocks, and the thing each unlocks turns
 *     out to be the connection itself.
 *
 * What is left on the Settings rail is what Settings is actually for: who can
 * sign in, how the company behaves, what it did, and what it spends. Nothing
 * with an outside service at the other end of it.
 */
export const CONNECTION_PAGES = [
  {
    id: "apps",
    label: "Apps",
    icon: LayoutGrid,
    hint: "The apps your agents act through",
    group: "integrations",
  },
  {
    // **Account**, not "API Key". Under a group already headed "API Keys" the
    // old label said the group's own name back at it and left the one thing
    // that distinguishes this row — that it is the platform account the rest
    // of the group's keys are billed to — unsaid. The id is untouched:
    // `#/connections/api-key` is an address, and a word on a rail is not a
    // reason to break one (`CONNECTIONS_NAMED_BY`, and `connectionsHref`).
    //
    // First under "API Keys", because it is the account the rest of that group
    // is billed to: the key that pays comes before the keys it pays for.
    id: "api-key",
    label: "Account",
    icon: KeyRound,
    hint: "The account this company spends through",
    group: "keys",
  },
  {
    id: "mcp",
    label: "MCP Servers",
    icon: Blocks,
    hint: "Tool servers and their tools",
    group: "integrations",
  },
  {
    // **LLM**, not "Inference". "Inference" names the act the model performs;
    // the thing an operator is here to choose is the model, and every other
    // console they have used — OpenHuman's own Connections rail included —
    // calls that row LLM. The id stays `inference`: `#/connections/inference`
    // is linked from the chat pane's "cannot reach a model" banner and from
    // workflow run rows, and a relabel is not a reason to break either.
    id: "inference",
    label: "LLM",
    icon: BrainCircuit,
    hint: "The model agents think with",
    group: "keys",
  },
  {
    // The Composio credential, as a page rather than a tab on Apps (issue
    // #2259). It was a column on that page and then a tab of it, on the
    // argument that a credential exists only to make a provider connectable:
    // one subject, two views. What that missed is what this rail is a list of —
    // things you connect *to*, and the keys that authorise them — and a key
    // reachable only by opening the page named after the things it unlocks and
    // then finding a tab is filed under the wrong half of that distinction.
    //
    // The coupling the tabs protected is preserved and is not a layout one: see
    // `views/connections/use-composio-credential.ts`, which both this page and
    // Apps read their credential state from.
    //
    // A NEW id, and the only kind of change to this table that is allowed: an
    // address that did not exist cannot break a link. Nothing above it moved.
    id: "composio",
    label: "Composio",
    icon: KeySquare,
    hint: "The key the app catalog runs on",
    group: "keys",
  },
  {
    id: "skills",
    label: "Skills",
    icon: Sparkles,
    hint: "Playbooks your agents read",
    group: "integrations",
  },
  {
    id: "hosting",
    label: "Hosting",
    icon: Globe,
    hint: "Where this company's sites go live",
    group: "others",
  },
  {
    id: "search",
    label: "Search",
    icon: Search,
    hint: "Where agents look things up",
    group: "keys",
  },
] as const satisfies readonly {
  id: string;
  label: string;
  icon: LucideIcon;
  hint: string;
  group: string;
}[];

export type ConnectionPage = (typeof CONNECTION_PAGES)[number]["id"];

export const DEFAULT_CONNECTION_PAGE: ConnectionPage = "apps";

/** Whether a hash segment names a real sub-page. */
export function isConnectionPage(sub: string | null): sub is ConnectionPage {
  return CONNECTION_PAGES.some((page) => page.id === sub);
}

/** The sub-page a hash segment resolves to, defaulting to Apps. */
export function resolveConnectionPage(sub: string | null): ConnectionPage {
  return isConnectionPage(sub) ? sub : DEFAULT_CONNECTION_PAGE;
}

/**
 * The console hash a link to one Connections sub-page needs.
 *
 * Typed for the same reason `settingsHref` is: a link written against this
 * cannot outlive the page it points at. `#/settings/connections` — hard-coded
 * in four places, pointing at a page that stopped existing when Connections was
 * split — is what happens without it.
 */
export function connectionsHref(page: ConnectionPage): string {
  return `#/connections/${page}`;
}

/**
 * The rail's groups, in the order it draws them.
 *
 * The same shape `SETTINGS_PAGE_GROUPS` has had all along — a `group` id on
 * each page, an ordered list of group labels beside it — because the two rails
 * sit side by side in one console and must not be two things to learn. The
 * grouping is presentational only: it changes no id, retires no page, and every
 * address under this section resolves exactly as it did.
 *
 * **Integrations** are the things a company connects *to*. **API Keys** are the
 * credentials that authorise the work. That distinction was already true of
 * these pages and an operator had to reconstruct it on every visit, because a
 * flat list says nothing about it. It is the same split OpenHuman's own
 * Connections page makes.
 *
 * **Apps is the first row of the first group, and that is load-bearing.** A
 * bare `#/connections` opens the first row of the rail (`rowActive` in
 * `sidebar-navigation.tsx`, and `DEFAULT_CONNECTION_PAGE` agreeing with it), so
 * moving the head of this list changes where every existing bookmark to the
 * section lands. The rail's order is the page table's order within each group,
 * which is why `composio` was **inserted** into that table rather than the
 * table being reordered around it.
 *
 * **Others** is one row, and is honest about it: Hosting is neither a thing you
 * connect through nor a key that authorises one, and filing it under either
 * would have made a group label lie to make a rail look tidier.
 */
export const CONNECTION_PAGE_GROUPS = [
  { id: "integrations", label: "Integrations" },
  { id: "keys", label: "API Keys" },
  { id: "others", label: "Others" },
] as const satisfies readonly {
  id: (typeof CONNECTION_PAGES)[number]["group"];
  label: string;
}[];

export type ConnectionPageGroup = (typeof CONNECTION_PAGE_GROUPS)[number]["id"];

/** The pages filed under one group, in the order the rail lists them. */
export function connectionPagesIn(
  group: ConnectionPageGroup,
): readonly (typeof CONNECTION_PAGES)[number][] {
  return CONNECTION_PAGES.filter((page) => page.group === group);
}
