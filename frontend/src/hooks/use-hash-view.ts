import { useCallback, useEffect, useState } from "react";

import { withHostParam } from "@/hooks/use-host-route";

/** The hash split into path segments: `#/settings/people` → `["settings", "people"]`. */
export function readSegments(): string[] {
  return window.location.hash
    .replace(/^#\/?/, "")
    .split("?")[0]
    .split("/")
    .filter(Boolean);
}

/**
 * The hash's query suffix: `#/connections/apps?tab=credentials` → `tab=credentials`.
 *
 * The half of the address `readSegments` throws away, and it is not always
 * noise. A page that carried a linkable `?tab=` (`use-hash-tab.ts`) and then
 * retired it has a bookmark to answer for, and the segments alone cannot tell
 * that address apart from the page's default — see the `?tab=credentials`
 * branch in `lib/console-route-rewrites.ts`.
 */
export function readQuery(): URLSearchParams {
  const [, query = ""] = window.location.hash.split("?");
  return new URLSearchParams(query);
}

/**
 * A tiny hash router: keeps the active view in `location.hash` (e.g.
 * `#/chat`, or `#/settings/people` for a view with sub-pages) so views
 * are linkable, survive refresh, and honor back/forward — without pulling in a
 * full router or disturbing the app's boot phases. Falls back to `fallback` for
 * unknown or empty hashes.
 *
 * The second segment comes back unvalidated: only the owning view knows which
 * of its sub-pages exist, so it does that check itself and falls back to its
 * own default.
 *
 * `rewrite` is how a retired address keeps working. It sees the raw segments
 * before anything else does and may name a different view to resolve to;
 * returning `null` — what it does for every ordinary address — leaves the
 * resolution exactly as it was. It runs *before* the validity check on purpose,
 * so an address whose view no longer exists can be sent somewhere real instead
 * of silently collapsing onto `fallback`.
 *
 * It is handed the hash's query beside the segments, because a retired address
 * is not always a retired *path*: a page that carried a linkable `?tab=` and
 * then split that tab out into a page of its own has a bookmark that differs
 * from the live address by the query alone. The rewrite stays a pure function
 * of the address — it reads the query it is given rather than `window` — so it
 * is testable the way every other branch in it is.
 *
 * The redirect lands through `canonicalize` below, which replaces rather than
 * pushes — and that is not an implementation detail. A retired address that
 * *pushed* its replacement would sit one Back away, bounce the operator forward
 * again on arrival, and trap them in a loop they cannot leave.
 */
export function useHashView<T extends string>(
  valid: readonly T[],
  fallback: T,
  rewrite?: (
    head: string,
    sub: string | null,
    query: URLSearchParams,
  ) => [T, string | null] | null,
  /**
   * How a route is spelled, when the console files some views under a prefix.
   *
   * Two halves of one decision, kept together so they cannot drift: `parse`
   * turns raw segments into a route, and `format` turns a route back into the
   * address that names it. Omit it and this stays the two-segment
   * `head[/sub]` router it has always been.
   *
   * `parse` runs BEFORE `rewrite` and before the validity check, and the order
   * is load-bearing. `#/company/work` has a valid head — `company` is a real
   * view — so the ordinary rules would resolve it to the Company page with a
   * sub-page of "work", which is a real page rendering the wrong thing rather
   * than an error anybody would notice. Returning `null` from `parse` is what
   * hands an address on to those rules unchanged.
   */
  path?: {
    parse: (segments: readonly string[]) => [T, string | null] | null;
    format: (view: T, sub: string | null) => string;
  },
): [
  T,
  string | null,
  (
    view: T,
    sub?: string,
    /** Query state that belongs to the destination, beside its route. */
    query?: Readonly<Record<string, string | null>>,
  ) => void,
] {
  const resolve = useCallback((): [T, string | null] => {
    const segments = readSegments();
    const prefixed = path?.parse(segments);
    if (prefixed) return prefixed;
    const [head, sub] = segments;
    const rewritten = rewrite?.(head ?? "", sub ?? null, readQuery());
    if (rewritten) return rewritten;
    // An unknown head takes its sub-page with it: the sub-page names a page of
    // a view that isn't on screen, so carrying it onto `fallback` would point
    // the fallback view at a sub-page it doesn't have.
    if (!(valid as readonly string[]).includes(head)) return [fallback, null];
    return [head as T, sub ?? null];
  }, [valid, fallback, rewrite, path]);

  const [route, setRoute] = useState<[T, string | null]>(resolve);

  /**
   * Rewrite the URL so it names the view actually on screen. An empty hash and
   * an unknown one (`#/finances` after a surface is retired, a typo, a stale
   * bookmark) both resolve to `fallback`, and without this the address bar
   * keeps claiming a view that isn't rendered.
   *
   * Replace semantics, never push: pushing leaves the unknown hash in the
   * history stack, so Back returns to it, this rewrite bounces forward again,
   * and the operator is stuck in a ping-pong they cannot Back out of.
   *
   * `withHostParam` carries the connection scope across the rewrite. The host
   * is part of the address (`use-host-route.ts`), and a `replaceState` fires no
   * `hashchange` — so a scope dropped here has nothing to put it back, and the
   * console would go on rendering one host under an address naming none.
   */
  const canonicalize = useCallback(
    (next: [T, string | null]) => {
      // Through `format`, so an address that arrived in an older spelling is
      // replaced with the canonical one rather than left standing. That is what
      // makes the prefix additive: `#/ledgers/goals` resolves, and the address
      // bar then says `#/company/work/goals` without anything having to
      // enumerate the retired forms.
      const next_path = path ? path.format(next[0], next[1]) : next[1] ? `${next[0]}/${next[1]}` : next[0];
      if (readSegments().join("/") === next_path) return;
      window.history.replaceState(null, "", withHostParam(next_path));
    },
    [path],
  );

  // Reflect the resolved view into the URL when the page arrived with no hash
  // or an unrecognized one.
  useEffect(() => {
    canonicalize(route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow browser back/forward and manual hash edits.
  useEffect(() => {
    const onHash = () => {
      const next = resolve();
      setRoute(next);
      canonicalize(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [resolve, canonicalize]);

  // The host scope rides along; every other query key is dropped, which is what
  // `useHashFlag`'s flags want — `?new` belongs to the screen it was opened
  // over, not to the one being navigated to.
  const navigate = useCallback((next: T, nextSub?: string, query?: Readonly<Record<string, string | null>>) => {
    const next_path = path ? path.format(next, nextSub ?? null) : nextSub ? `${next}/${nextSub}` : next;
    const nextHash = withHostParam(next_path, query);
    // A navigation without an explicit query changes only the route. Preserve
    // query state when the destination path is unchanged so durable link state
    // (for example, a focused workflow run) remains represented by the URL.
    const currentPath = window.location.hash.split("?")[0];
    const nextPath = nextHash.split("?")[0];
    const currentQuery = window.location.hash.includes("?")
      ? window.location.hash.slice(window.location.hash.indexOf("?") + 1)
      : "";
    const destinationHash =
      query === undefined && currentPath === nextPath && currentQuery
        ? `${nextPath}?${currentQuery}`
        : nextHash;
    if (window.location.hash !== destinationHash) {
      window.location.hash = destinationHash;
    }
    setRoute([next, nextSub ?? null]);
  }, [path]);

  return [route[0], route[1], navigate];
}
