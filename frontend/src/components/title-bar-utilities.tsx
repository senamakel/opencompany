// Settings, Feedback and Discord, as glyphs in the window's title row.
//
// These were three labelled rows in the sidebar's footer (`SidebarUtilityBar`),
// and before that three icon-only buttons in the sidebar's header. The footer
// argument was that below the destinations there is nothing left for a label to
// push down, so naming them cost nothing — which was true about the column and
// says nothing about whether the column is where they belong.
//
// What moves them here is what they are. The sidebar is the list of places
// inside this company: the room, the roster, the connections, the flows, what
// is waiting on you. None of these three is that. Settings and Feedback act on
// the *console*, and Discord leaves the product altogether — so a footer under
// the destinations was a way of saying "not one of these" by position, in the
// one region of the screen whose entire job is to enumerate destinations.
//
// The title row already says that by construction. It is chrome: it holds the
// controls that are about the console rather than about the page, it does not
// scroll, it does not collapse, and it is the same on every view. Overview was
// moved into it on exactly this reasoning and these three sit beside it.
//
// **Glyphs, not labels**, and that is the trade the sidebar footer made in
// reverse: a labelled button in a band of chrome reads as content, while an
// unlabelled glyph in a list of named rows reads as decoration. Each keeps
// `aria-label` and `title` — the whole of what a screen reader and a hovering
// pointer respectively get from an icon-only control — so only the pixels go.

import { Settings } from "lucide-react";

import { DiscordIcon } from "@/components/discord-icon";
import { TITLE_BAR_ICON_BUTTON } from "@/components/window-title-bar";
import { DISCORD_INVITE_URL } from "@/lib/links";
import type { View } from "@/lib/console-routes";
import { cn } from "@/lib/utils";

/**
 * Discord's brand blurple, lifted a step in dark mode so it clears the chrome
 * instead of sinking into it.
 *
 * Named tokens rather than raw hex — the colour is deliberately not ours, and
 * saying so in the token name is what stops it being "fixed" into the palette
 * later. Carried over from `sidebar-controls.tsx`, which had it for the same
 * reason and no longer draws this control.
 */
const DISCORD_BLURPLE = "text-(--brand-discord-on-light) dark:text-(--brand-discord-on-dark)";

/** The accessible names, stated once so a test and a button cannot drift. */
export const SETTINGS_LABEL = "Settings";
export const DISCORD_LABEL = "Join our Discord";

export function TitleBarUtilities({
  view,
  onNavigate,
}: {
  /** The active view, so Settings and Feedback can show as current. */
  view: View;
  onNavigate: (view: View) => void;
}) {
  return (
    <>
      <button
        type="button"
        data-testid="title-bar-settings"
        // Kept from the sidebar row this replaces: the guided tour's
        // "Connect your tools" stop spotlights this anchor, and moving the
        // control is not a reason to move the anchor off it.
        data-tour="nav-settings"
        onClick={() => onNavigate("settings")}
        // `aria-current="page"` rather than a fill alone — a background is not
        // a channel every operator receives, and it is what
        // `TITLE_BAR_ICON_BUTTON`'s own active styling keys off, so the state
        // and its appearance have one source.
        aria-current={view === "settings" ? "page" : undefined}
        aria-label={SETTINGS_LABEL}
        title={SETTINGS_LABEL}
        className={TITLE_BAR_ICON_BUTTON}
      >
        <Settings aria-hidden="true" className="size-4" />
      </button>
      {/* Feedback was here, and is a row on the Settings rail now
          (`#/settings/feedback`). A glyph in this row put it on a par with
          "where you are" and "what the agents may do", which is the company you
          keep when you are chrome — and it is a page you visit rarely and
          deliberately. Settings is the list of those. */}
      {/* An anchor, not a button: it leaves the product, so it has to behave
          like a link — middle-click, copy address, open in a new tab. */}
      <a
        data-testid="title-bar-discord"
        href={DISCORD_INVITE_URL}
        target="_blank"
        rel="noreferrer"
        aria-label={DISCORD_LABEL}
        title={DISCORD_LABEL}
        className={cn(
          TITLE_BAR_ICON_BUTTON,
          // The hue is what sets this apart from its two neighbours, so it
          // survives hover rather than being replaced by the shared accent
          // foreground `TITLE_BAR_ICON_BUTTON` applies.
          DISCORD_BLURPLE,
          "hover:text-(--brand-discord-on-light) dark:hover:text-(--brand-discord-on-dark)",
          // The one item in this row allowed to go when the row runs out of
          // width. Nothing here scrolls and everything else is `flex-none`, so
          // the band has a hard minimum: measured in a browser, the profile
          // group's right edge sits at 483px with the Notifications bell in the
          // row and 447px without it, and below that the trailing controls fall
          // under the shell's `overflow-hidden` (Codex).
          //
          // This glyph is what gives the bell's 36px back, and it is the right
          // one to take it from: an external community invite rather than
          // console function, the only control in the row that leaves the
          // product, and the only one whose absence costs an operator nothing
          // they cannot reach another way. The bell itself could not go — it is
          // the only route to Approvals now, and a count that hides itself at
          // narrow widths is the whole of issue #1018.
          //
          // `max-sm:hidden` rather than `hidden sm:inline-flex`: both halves of
          // that pair are plain `display` utilities in one layer, so which wins
          // is decided by Tailwind's emission order rather than by anything
          // written here. A `max-` variant is a media block and simply wins.
          "max-sm:hidden",
        )}
      >
        <DiscordIcon className="size-4" />
      </a>
    </>
  );
}
