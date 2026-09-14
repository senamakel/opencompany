import { tauriCore } from "@/api/transport/bridge";

/**
 * Hand an outward link to the operator's browser when the console is running
 * inside the desktop shell.
 *
 * # Why this exists
 *
 * Every outward link in the console is an ordinary anchor —
 * `<a href={url} target="_blank" rel="noreferrer">`. In a browser that opens a
 * tab. A Tauri webview has no tab to open and no browser to open it in, so the
 * click does nothing at all: no window, no error, no console message. The
 * operator sees a link that is not a link.
 *
 * That was every one of them, on every screen, including the first-run wizard's
 * only route to an API key — so an operator who did not already hold one had no
 * way forward on the first screen of a build they had just installed.
 *
 * # Why a delegated listener rather than a component
 *
 * A helper each anchor calls fixes the anchors that remember to call it. The
 * next one written is dead again, silently, and the failure only shows up in a
 * packaged build. One capture-phase listener covers the anchors that exist and
 * the ones nobody has written yet.
 *
 * It does **not** cover a URL opened from code — `window.open` never reaches a
 * click handler — so those call sites use [`openOutward`] directly.
 *
 * # Why it is inert on the web
 *
 * `tauriCore()` is `null` in a browser, so nothing is intercepted and the
 * anchor's own behaviour stands. The console keeps working in a normal tab
 * exactly as before, which is also what keeps the E2E suite meaningful.
 */
export function installExternalLinkOpener(
  doc: Document = document,
): () => void {
  /**
   * `click` carries the primary button, `auxclick` the middle one. Both ask for
   * a new tab on an anchor the webview cannot give one, so both are handled —
   * dropping every non-primary event left middle-click inert (Codex review on
   * #2283).
   */
  const onActivate = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    const wanted = event.type === "auxclick" ? 1 : 0;
    if (event.button !== wanted) return;

    const anchor = (event.target as Element | null)?.closest?.("a");
    const href = anchor?.getAttribute("href")?.trim();
    if (!anchor || !href) return;
    if (!isOutwardHref(href)) return;

    // ONLY a link that asked for a separate tab. An absolute `href` with no
    // target is a top-level navigation the console means to perform in place,
    // and the hub sign-in buttons are exactly that: `Login.tsx` sends the
    // browser to the provider's OAuth start and reads the token back off this
    // same window when it returns. Handing those to the system browser would
    // land the callback there and leave the desktop webview permanently signed
    // out — a worse bug than the one this module fixes (Codex review on #2283).
    if (anchor.getAttribute("target")?.toLowerCase() !== "_blank") return;

    // The bridge is probed BEFORE the modifier keys are considered, and the
    // order is the point. A Cmd- or Ctrl-click asks for "open in a new tab",
    // and honouring that in the desktop shell means falling back to the very
    // `_blank` path that does nothing here — so the gesture most likely to be
    // used on a link would be the one most likely to look broken. In a browser
    // the bridge is absent, this returns, and the platform's own behaviour
    // stands untouched.
    //
    // Probed at click time, not at install time: a listener installed before
    // the bridge is injected would otherwise decide "web" once and stay wrong
    // for the life of the window.
    if (!tauriCore()) return;

    event.preventDefault();
    openOutward(href);
  };

  doc.addEventListener("click", onActivate, true);
  doc.addEventListener("auxclick", onActivate, true);
  return () => {
    doc.removeEventListener("click", onActivate, true);
    doc.removeEventListener("auxclick", onActivate, true);
  };
}

/**
 * Open `url` outside the console, wherever the console happens to be running.
 *
 * Returns whether the desktop shell took it. `false` means this is a browser,
 * and the caller's own `window.open` is what opens it — the web path is
 * deliberately left alone rather than routed through here.
 *
 * Exported for the call sites a click listener cannot see. An OAuth flow that
 * calls `window.open` from code hands the webview a popup it cannot create, so
 * the authorization page never appears while the console starts polling and
 * says "complete sign-in" — a worse failure than a dead link, because it looks
 * like progress.
 */
export function openOutward(url: string): boolean {
  const core = tauriCore();
  if (!core) return false;
  // Fire-and-forget. A rejection means the shell refused the open, and there is
  // nothing this layer can do that is better than leaving the operator where
  // they were — but it must not surface as an unhandled rejection.
  void core
    .invoke("plugin:shell|open", { path: absoluteOutwardUrl(url) })
    .catch(() => {});
  return true;
}

/**
 * Whether this `href` leaves the console.
 *
 * Kept in step with `isExternalHref` in `components/markdown.tsx`, which is what
 * decides whether user-authored Markdown gets `target="_blank"` at all: a link
 * that renderer sends outward and this one calls internal is a link the desktop
 * leaves inert, which is the bug this module exists to remove. That includes
 * **protocol-relative** `//host/…`, which reads like a path and is not one.
 *
 * `mailto:` is outward here though that renderer leaves it in place — the two
 * answer different questions. It asks whether to open a tab; this asks whether
 * the operating system should take the URL, and a mail client is exactly the
 * thing that should.
 *
 * An in-app hash route, a rooted path and a `blob:`/`data:` URL are not
 * outward, and handing any of them to the operating system would replace a
 * working in-app link with a failed one.
 */
export function isOutwardHref(href: string): boolean {
  const value = href.trim();
  if (!value) return false;
  return /^((https?:)?\/\/|mailto:)/i.test(value);
}

/**
 * A URL the operating system can act on.
 *
 * A protocol-relative `//host/…` inherits the page's scheme in a browser. In
 * the desktop shell that scheme is Tauri's own custom protocol, so inheriting
 * it would produce an address no browser can open; `https` is both the safe
 * reading and the one every such link in the console means.
 */
function absoluteOutwardUrl(url: string): string {
  const value = url.trim();
  return value.startsWith("//") ? `https:${value}` : value;
}
