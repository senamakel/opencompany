import { Building2, MessageSquareWarning, PanelLeft } from "lucide-react";

import type { CompanyStatus } from "@/api/types";
import type { View } from "@/components/app-shell";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { DiscordIcon } from "@/components/discord-icon";
import { lifecycle } from "@/lib/language";
import { DISCORD_INVITE_URL } from "@/lib/links";
import { cn } from "@/lib/utils";

// The lifecycle row carries its state in the label as well as the dot — a
// coloured dot alone puts the whole signal on hue, which a colourblind reader
// or a glance at the collapsed rail can miss.
const TONE_DOT: Record<string, string> = {
  live: "bg-status-done",
  idle: "bg-status-blocked",
  stopped: "bg-status-failed",
};

const TONE_TEXT: Record<string, string> = {
  live: "text-status-done-text",
  idle: "text-status-blocked-text",
  stopped: "text-status-failed-text",
};

// Discord's brand blurple, lifted a step in dark mode so it clears the
// sidebar's surface instead of sinking into it. Named tokens rather than raw
// hex — the colour is deliberately not ours, and saying so in the token name
// is what stops it being "fixed" into the palette later. See `--brand-discord`
// in index.css.
const DISCORD_BLURPLE =
  "text-(--brand-discord-on-light) dark:text-(--brand-discord-on-dark)";

/**
 * A sidebar row at rest: dimmed until you reach for it.
 *
 * The sidebar is standing furniture, on screen behind every view — holding the
 * whole list at full strength makes ten equal-weight rows compete with the
 * content beside them. Hover, keyboard focus, and the active row all come back
 * to full, so nothing is ever dimmed at the moment you are using it.
 */
// `data-active` is a bare boolean attribute on these buttons, not
// `data-active="true"` — match it the same way the sidebar's own styles do.
export const RESTING_ROW =
  "opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 data-active:opacity-100";

interface Props {
  /** The company's lifecycle, shown as a dot + label. */
  lifecycleState: string;
  /**
   * Issue #86: whether the governance kill switch is engaged. Overrides the
   * lifecycle label, because a stopped company still reports `running` and this
   * row is the one piece of company state on screen behind every view.
   */
  emergencyPaused?: boolean;
  /** Every company this operator can reach, for the switcher. */
  companies: CompanyStatus[];
  activeCompany: string | null;
  onSwitchCompany: (id: string) => void;
  onBackToPicker?: () => void;
  /** The active view, so the Feedback row can show as selected. */
  view: View;
  onNavigate: (view: View) => void;
}

/**
 * The sidebar's standing controls.
 *
 * No page carries a header of its own any more, so what is left of the old top
 * bar lives here: the company's state and the switcher. Collapsing is its own
 * control at the top of the sidebar (`SidebarCollapseToggle`). Theming and
 * flagging are deliberately absent — Settings owns both, under Appearance and
 * "Something off?", and a second entry point would just be two places to keep
 * in step.
 */
export function SidebarControls({
  lifecycleState,
  emergencyPaused,
  companies,
  activeCompany,
  onSwitchCompany,
  onBackToPicker,
  view,
  onNavigate,
}: Props) {
  const { label, tone } = lifecycle(lifecycleState, emergencyPaused);

  return (
    <SidebarMenu>
      {/* Company state. Not a control — `cursor-default` and inert, so it does
          not read as something to press. */}
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={label}
          className={cn("cursor-default font-medium hover:bg-transparent", TONE_TEXT[tone])}
        >
          <span className="flex size-4 items-center justify-center">
            <span
              className={cn(
                "size-2 rounded-full",
                TONE_DOT[tone],
                tone === "live" && "animate-pulse",
              )}
            />
          </span>
          <span>{label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>

      {/* Feedback is a destination like any nav item, but it belongs with the
          standing controls at the bottom rather than in the working nav. */}
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip="Feedback"
          isActive={view === "feedback"}
          onClick={() => onNavigate("feedback")}
          className={RESTING_ROW}
        >
          <MessageSquareWarning />
          <span>Feedback</span>
        </SidebarMenuButton>
      </SidebarMenuItem>

      {/* Switching companies lived in the header block that was removed. It
          is a real capability, so it moves here rather than disappearing —
          hidden entirely when there is only one company to be in. */}
      {(companies.length > 1 || onBackToPicker) && (
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<SidebarMenuButton tooltip="Switch company" className={RESTING_ROW} />}
            >
              <Building2 />
              <span>Switch company</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="right">
              {companies.map((c) => (
                <DropdownMenuItem
                  key={c.id}
                  onClick={() => onSwitchCompany(c.id)}
                  className={c.id === activeCompany ? "font-medium" : undefined}
                >
                  {c.name}
                </DropdownMenuItem>
              ))}
              {onBackToPicker && (
                <DropdownMenuItem onClick={onBackToPicker}>All companies…</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      )}

      <SidebarMenuItem>
        {/* Deliberately NOT `RESTING_ROW`.

            The resting dim is `opacity-60`, which is safe for a row of
            near-white text — 16.87:1 becomes 6.60:1 — and destroys a
            mid-tone hue: the blurple measures 6.36:1 at full strength and
            3.04:1 dimmed, under the 4.5:1 a 14px label needs. Recovering
            that inside the dim would mean lightening the blurple by five
            steps, at which point it is a pale lavender and no longer reads
            as Discord's colour at all.

            So this row is not dimmed. Its hue already sets it apart from the
            nav above, without help from the property doing the damage. */}
        <SidebarMenuButton
          tooltip="Join our Discord"
          className={cn(
            DISCORD_BLURPLE,
            "hover:text-(--brand-discord-on-light) dark:hover:text-(--brand-discord-on-dark)",
          )}
          render={<a href={DISCORD_INVITE_URL} target="_blank" rel="noreferrer" />}
        >
          <DiscordIcon className="size-4" />
          <span>Join our Discord</span>
        </SidebarMenuButton>
      </SidebarMenuItem>

    </SidebarMenu>
  );
}

/**
 * The collapse toggle, at the top of the sidebar.
 *
 * It sits above the nav rather than among the footer controls, because it is
 * the one control here that acts on the sidebar itself — everything below it
 * navigates. Expanded, it stays quiet and reads as another row; collapsed, it
 * takes the primary fill, so the single control that gets the rail back is the
 * one thing standing out in a column of identical icons.
 */
export function SidebarCollapseToggle() {
  const { toggleSidebar, state } = useSidebar();
  const collapsed = state === "collapsed";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggleSidebar}
          className={cn(
            collapsed
              ? "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
              : RESTING_ROW,
          )}
        >
          <PanelLeft className={cn("transition-transform", collapsed && "rotate-180")} />
          <span>Collapse</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

