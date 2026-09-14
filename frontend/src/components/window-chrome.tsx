// The desktop window's own chrome: what replaces the native title bar once the
// window stops drawing one.
//
// `crates/opencompany-app/tauri.conf.json` runs the main window with `titleBarStyle:
// "Overlay"` and `hiddenTitle: true`, which is macOS's transparent title bar:
// the bar itself is gone, the traffic lights float over the web content, and
// the window keeps its rounded corners and its resize edges. Two things stop
// working the moment that happens, and this file is both of them.
//
// **Dragging.** With no title bar there is nothing to grab. macOS does not make
// the top of the content draggable on its own — the webview captures the
// pointer — so a band has to opt back in with `data-tauri-drag-region`. See
// {@link WindowDragBar}.
//
// **The lights' backdrop.** They are drawn over whatever is at the window's
// top-left, which in this console is the sidebar's company switcher. A control
// under three floating circles is a control you cannot click. See
// {@link WindowControlsInset}, which reserves the strip they land in.
//
// Both are macOS-and-desktop only. Windows and Linux keep their native
// decorated title bar (`Overlay` is a no-op there), so reserving a band would
// waste vertical space, and in a browser there is no window to drag at all.
// This mirrors `WindowDragBar.tsx` and `AppSidebar.tsx` in the vendored
// OpenHuman checkout, which solved the same two problems for the same reason.

import { isDesktopRuntime } from "@/api/transport";

/**
 * Height of the reserved strip, in px, and the height of the drag band.
 *
 * It is the macOS traffic-light zone: 28px clears the three buttons at their
 * standard size with a hair of margin. `trafficLightPosition.y` in
 * `tauri.conf.json` is tuned against this number — see the note there — so the
 * two move together or the lights sit off-centre in their own strip.
 */
export const WINDOW_CHROME_HEIGHT = 28;

/**
 * Height of the console's own title row, in px.
 *
 * **A layout choice now, and it did not used to be.** While the shell drew its
 * own chrome this number was derived: the traffic lights floated *inside* this
 * row, the row centres its contents with `align-items: center`, and the lights
 * were the one item in it this code could not move — so the height had to be
 * exactly twice their centre line (`2 * (trafficLightPosition.y + 6)`) or they
 * sat off it. Change one, change the other.
 *
 * The window is natively decorated again, so the lights are in the OS title bar
 * above this row and that constraint is gone. 52 is kept because it is a good
 * height for what the row actually carries — comfortably clear of the 36px
 * switcher trigger, which the 28px sidebar strip this row replaced was not —
 * and no longer because any pixel of it is owed to the OS.
 *
 * The derivation is recorded rather than deleted because restoring
 * `titleBarStyle: "Overlay"` restores the constraint with it: this must go back
 * to `2 * (trafficLightPosition.y + 6)` in the same change.
 */
export const WINDOW_TITLE_BAR_HEIGHT = 52;

/**
 * How far into the window the traffic lights reach, in px.
 *
 * `trafficLightPosition.x` is 20 and macOS draws three 12px buttons on a 20px
 * pitch, so the last one ends at 20 + 2*20 + 12 = 72. This is that number and
 * not a pixel more: the clearance between the lights and whatever stands beside
 * them is the title row's own padding, so this constant stays a statement about
 * where the OS draws and the spacing stays a statement about the layout.
 */
export const WINDOW_CONTROLS_WIDTH = 72;

/**
 * Whether the shell hides the native title bar and draws its own.
 *
 * **This must agree with `crates/opencompany-app/tauri.conf.json`.** The window runs with
 * `decorations: true` and no `titleBarStyle`, so macOS draws an ordinary title
 * bar and the traffic lights sit in it — there is nothing for the console to
 * reserve space for or make draggable, and both {@link WindowDragBar} and
 * {@link WindowControlsInset} render nothing.
 *
 * Read from a constant rather than inferred from the platform, which is the bug
 * this replaces: the old check asked "is this a mac desktop?" and answered
 * "then the title bar is an overlay", so the config and the layout agreed only
 * by coincidence. Flipping `titleBarStyle` back in `tauri.conf.json` without
 * touching this file would have left a 72px hole where the lights used to be,
 * with nothing in the console to explain it.
 *
 * The platform half is kept because it is still a precondition: `Overlay` is a
 * macOS style, so a Windows or Linux desktop keeps its native title bar however
 * this constant is set.
 */
const SHELL_DRAWS_ITS_OWN_TITLE_BAR = false;

export function usesOverlayTitleBar(): boolean {
  if (!SHELL_DRAWS_ITS_OWN_TITLE_BAR) return false;
  if (!isDesktopRuntime()) return false;
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac/i.test(platform);
}

/**
 * The transparent band that makes the top of the window draggable again.
 *
 * Absolutely positioned over the top of whatever it is placed in, so it
 * reserves no vertical space and adds no inherited inset to the page below it.
 * `aria-hidden` because it is window chrome: there is nothing here for a screen
 * reader, and a landmark-free empty div would otherwise be announced as one
 * more thing to skip.
 *
 * `pointer-events-none` is deliberately NOT set. The band has to receive the
 * press for macOS to start a drag, which means it also swallows clicks in the
 * strip it covers — that is why it is only ever placed over space nothing else
 * is using.
 */
export function WindowDragBar({ className }: { className?: string }) {
  if (!usesOverlayTitleBar()) return null;
  return (
    <div
      data-tauri-drag-region
      data-testid="window-drag-bar"
      aria-hidden="true"
      className={`absolute inset-x-0 top-0 z-20 ${className ?? ""}`}
      style={{ height: WINDOW_CHROME_HEIGHT }}
    />
  );
}

/**
 * The space the traffic lights sit in, at the left end of the title row.
 *
 * It used to reserve a strip *above* the company switcher, because the switcher
 * was the top-left of the sidebar and the lights were landing on it. The
 * switcher now stands in a full-width title row instead, so the collision is
 * horizontal rather than vertical and so is the answer: the lights take the
 * first {@link WINDOW_CONTROLS_WIDTH} pixels of the row and everything else
 * starts to their right.
 *
 * That is the whole reason this is a spacer and not a margin on the switcher.
 * The row centres every item on one line with a single `items-center`, and a
 * per-item offset is exactly the thing that stops being right the moment
 * another item joins the row or a font loads late.
 *
 * It is draggable as well as reserved. The alternative is a band of dead window
 * beside a control an operator will try to grab, and a title bar you cannot
 * drag is stranger than no title bar at all.
 */
export function WindowControlsInset() {
  if (!usesOverlayTitleBar()) return null;
  return (
    <div
      data-tauri-drag-region
      data-testid="window-controls-inset"
      aria-hidden="true"
      className="h-full flex-none"
      style={{ width: WINDOW_CONTROLS_WIDTH }}
    />
  );
}
