// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installExternalLinkOpener,
  isOutwardHref,
  openOutward,
} from "@/lib/external-links";

/**
 * The desktop shell's bridge, as `tauriCore()` probes for it: `window.__TAURI__`
 * carrying a callable `core.invoke`. Anything less is not a bridge, which is the
 * web case.
 */
function asDesktop(invoke = vi.fn().mockResolvedValue(undefined)) {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: { invoke },
  };
  return invoke;
}

function asBrowser() {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

function clickAnchor(
  href: string,
  init: MouseEventInit = {},
  opts: { target?: string | null; type?: "click" | "auxclick" } = {},
) {
  const anchor = document.createElement("a");
  anchor.setAttribute("href", href);
  const target = opts.target === undefined ? "_blank" : opts.target;
  if (target !== null) anchor.setAttribute("target", target);
  document.body.append(anchor);
  const event = new MouseEvent(opts.type ?? "click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  anchor.dispatchEvent(event);
  return event;
}

afterEach(() => {
  asBrowser();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("isOutwardHref", () => {
  it("takes the schemes that leave the console", () => {
    expect(isOutwardHref("https://openrouter.ai/keys")).toBe(true);
    expect(isOutwardHref("http://localhost:8080/x")).toBe(true);
    expect(isOutwardHref("mailto:someone@example.com")).toBe(true);
  });

  /**
   * The console addresses itself with hash routes, and `WorkspaceView` and the
   * chat surface both build relative hrefs. Handing either to the operating
   * system would replace a working in-app link with a failed one — a worse bug
   * than the one this fixes.
   */
  it("leaves in-app and embedded addresses alone", () => {
    expect(isOutwardHref("#/company/workspace/n-1")).toBe(false);
    expect(isOutwardHref("/api/v1/company")).toBe(false);
    expect(isOutwardHref("blob:abc")).toBe(false);
    expect(isOutwardHref("data:text/plain,x")).toBe(false);
    expect(isOutwardHref("")).toBe(false);
  });
});

describe("installExternalLinkOpener", () => {
  /**
   * The defect itself: in the desktop shell an outward anchor did nothing at
   * all. The click must now reach the shell instead of being swallowed.
   */
  it("hands an outward link to the shell in the desktop build", () => {
    const invoke = asDesktop();
    const dispose = installExternalLinkOpener();

    const event = clickAnchor("https://openrouter.ai/keys");

    expect(invoke).toHaveBeenCalledWith("plugin:shell|open", {
      path: "https://openrouter.ai/keys",
    });
    expect(event.defaultPrevented).toBe(true);
    dispose();
  });

  /**
   * A browser already opens a tab. Intercepting there would be a regression
   * dressed as a fix, and it is also what keeps the console E2E suite — which
   * runs in a browser — a meaningful check of these links.
   */
  it("does nothing in a browser", () => {
    asBrowser();
    const dispose = installExternalLinkOpener();

    const event = clickAnchor("https://openrouter.ai/keys");

    expect(event.defaultPrevented).toBe(false);
    dispose();
  });

  it("leaves an in-app hash route to the router", () => {
    const invoke = asDesktop();
    const dispose = installExternalLinkOpener();

    const event = clickAnchor("#/company/workspace/n-1");

    expect(invoke).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    dispose();
  });

  /**
   * A Cmd/Ctrl-click asks for a new tab. In the desktop shell that is the very
   * `_blank` path that opens nothing, so the most natural gesture on a link
   * would be the one that still looked broken (Codex review on #2283).
   */
  it("hands a modified click to the shell in the desktop build", () => {
    const invoke = asDesktop();
    const dispose = installExternalLinkOpener();

    const event = clickAnchor("https://openrouter.ai/keys", { metaKey: true });

    expect(invoke).toHaveBeenCalledWith("plugin:shell|open", {
      path: "https://openrouter.ai/keys",
    });
    expect(event.defaultPrevented).toBe(true);
    dispose();
  });

  /** In a browser the platform's own new-tab behaviour is already right. */
  it("leaves a modified click to the browser", () => {
    asBrowser();
    const dispose = installExternalLinkOpener();

    const event = clickAnchor("https://openrouter.ai/keys", { metaKey: true });

    expect(event.defaultPrevented).toBe(false);
    dispose();
  });

  /**
   * `markdown.tsx`'s `isExternalHref` sends `//host/…` outward and gives it
   * `target="_blank"`. A renderer that calls it external and this module that
   * called it internal left exactly that class of link inert (Codex review).
   */
  it("opens a protocol-relative link, with a scheme the OS can act on", () => {
    const invoke = asDesktop();
    const dispose = installExternalLinkOpener();

    clickAnchor("//example.com/docs");

    expect(invoke).toHaveBeenCalledWith("plugin:shell|open", {
      path: "https://example.com/docs",
    });
    dispose();
  });

  /**
   * A refusal from the shell must not surface as an unhandled rejection — the
   * operator is left where they were, and nothing else breaks.
   */
  it("swallows a shell refusal", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("denied"));
    asDesktop(invoke);
    const dispose = installExternalLinkOpener();

    clickAnchor("https://openrouter.ai/keys");
    await Promise.resolve();

    expect(invoke).toHaveBeenCalled();
    dispose();
  });

  it("stops intercepting once disposed", () => {
    const invoke = asDesktop();
    const dispose = installExternalLinkOpener();
    dispose();

    const event = clickAnchor("https://openrouter.ai/keys");

    expect(invoke).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("openOutward", () => {
  /**
   * The call sites a click listener cannot see. An OAuth flow calling
   * `window.open` hands the webview a popup it cannot create, so the
   * authorization page never appears while the console polls and says
   * "complete sign-in" — progress that is not happening (Codex review on #2283).
   */
  it("takes the url in the desktop build and reports that it did", () => {
    const invoke = asDesktop();

    expect(openOutward("https://app.composio.dev")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("plugin:shell|open", {
      path: "https://app.composio.dev",
    });
  });

  /** `false` is what tells the caller its own `window.open` is still correct. */
  it("declines in a browser so the caller opens its own tab", () => {
    asBrowser();

    expect(openOutward("https://app.composio.dev")).toBe(false);
  });
});

describe("what must not be intercepted", () => {
  /**
   * The hub sign-in buttons in `Login.tsx` are absolute anchors with **no**
   * target: the OAuth start is a top-level navigation and the token is read
   * back off this same window when the provider returns. Sending one to the
   * system browser lands the callback there and leaves the desktop webview
   * signed out for good (Codex review on #2283).
   */
  it("leaves an absolute anchor with no target to navigate in place", () => {
    const invoke = asDesktop();
    const dispose = installExternalLinkOpener();

    const event = clickAnchor(
      "https://hub.example/oauth/start",
      {},
      { target: null },
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    dispose();
  });

  it("leaves an anchor targeting the same window alone", () => {
    const invoke = asDesktop();
    const dispose = installExternalLinkOpener();

    clickAnchor("https://example.com/x", {}, { target: "_self" });

    expect(invoke).not.toHaveBeenCalled();
    dispose();
  });

  /** Middle-click asks for the same tab the webview cannot create. */
  it("hands a middle-click to the shell in the desktop build", () => {
    const invoke = asDesktop();
    const dispose = installExternalLinkOpener();

    const event = clickAnchor(
      "https://example.com/x",
      { button: 1 },
      { type: "auxclick" },
    );

    expect(invoke).toHaveBeenCalledWith("plugin:shell|open", {
      path: "https://example.com/x",
    });
    expect(event.defaultPrevented).toBe(true);
    dispose();
  });

  /** Leading whitespace must not reach the shell's URL matcher (CodeRabbit). */
  it("passes a trimmed url to the shell", () => {
    const invoke = asDesktop();
    const dispose = installExternalLinkOpener();

    clickAnchor("  https://example.com/x  ");

    expect(invoke).toHaveBeenCalledWith("plugin:shell|open", {
      path: "https://example.com/x",
    });
    dispose();
  });
});
