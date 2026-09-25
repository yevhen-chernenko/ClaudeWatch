// SPDX-License-Identifier: GPL-2.0-or-later

import St from "gi://St";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Clutter from "gi://Clutter";
import Pango from "gi://Pango";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { deriveEffectiveStatus, type SessionState } from "./state.js";
import { AgentLabel } from "./agentLabel.js";
import { pickAgentName } from "./agentNames.js";
import { isSessionAlive, isStale } from "./staleness.js";

// Each live session gets its own label with the same state machine the
// single-session version had, minus the shared "standby" state: idle
// sessions don't get a label at all (see "Agents are recovering ☕" below), a task in
// flight ("running", pulsing), paused on a permission prompt or question
// ("waiting", static), a manual /compact in progress ("compacting", pulsing
// at the same rate as running), a Stop that landed while a subagent it
// spawned hasn't reported back yet ("consulting", pulsing — see
// waiting_background in hooks/lib/status.ts), and the 5s flash right after a
// task finishes ("complete", static) before the label is removed for good.
const STANDBY_TEXT = "Agents are recovering ☕";

// Backgrounds are all white-text-on-color, AA-contrast checked (≥4.5:1
// against #ffffff at this weight/size).
const STANDBY_STYLE =
  "padding: 0 6px; background-color: #333a3d; border-radius: 4px; color: #ffffff;"; // 11.6:1
const OVERFLOW_STYLE =
  "padding: 0 6px; background-color: #333a3d; border-radius: 4px; color: #ffffff;"; // 11.6:1

// Labels beyond this count collapse into a single "+N more" chip so the
// panel bar can't grow unbounded with many concurrent sessions — full
// detail for every session is always in the popup menu.
const MAX_INLINE_AGENTS = 3;

// D-Bus service owned by the usage/ pip package (see usage/.../service.py).
// The bus starts it on demand once `claudewatch-usage install-service` has
// put its activation file in place.
const USAGE_BUS_NAME = "io.github.yevhen_chernenko.ClaudeWatchUsage";
const USAGE_OBJECT_PATH = "/io/github/yevhen_chernenko/ClaudeWatchUsage";
const USAGE_INTERFACE = USAGE_BUS_NAME;
const USAGE_INSTALL_HINT =
  "pipx install --force claudewatch-usage && claudewatch-usage install-service";
const USAGE_LABEL = "Show usage";
const USAGE_HINT_TEXT =
  "Usage service not installed. Click this message to copy the install commands to your clipboard.";
const USAGE_HINT_COPIED_TEXT =
  "Copied. Paste into a terminal, then click Show usage again.";
// Generous enough to cover the bus activating the service from cold.
const USAGE_CALL_TIMEOUT_MS = 10_000;

// Every visual the panel can ever show, for the CLAUDEWATCH_DEV preview menu
// (see ClaudeWatchIndicator's constructor) — one entry per AgentLabel UiState plus
// "standby" (no label at all) and "overflow" (the "+N more" chip), so the
// menu can cover every possible look without needing a real session.
type PreviewKind =
  | "standby"
  | "running"
  | "waiting"
  | "compacting"
  | "consulting"
  | "complete"
  | "overflow";

// Whether the "Dev: preview state" menu section should be built — read from
// a `.env` file shipped next to extension.js in the
// extension's own directory (copy-assets.mjs copies the repo root's .env
// there, when one exists) rather than a process env var: GNOME Shell runs as
// a long-lived session process that inherits its environment from the
// display manager / login session, not from whatever terminal you happen to
// run `npm run build` in, so a real env var set there would never actually
// reach it. A repo-root `.env` (gitignored, same as any other local-only
// config) sidesteps that entirely. Async even though this only ever runs
// once, at ClaudeWatchIndicator construction — no sync file I/O on the shell
// main loop, full stop, matching every other file read in this extension.
// The dev preview section simply appears a tick after the rest of the menu
// instead of atomically with it, which nothing else here depends on.
function readDevModeFlagAsync(
  extensionPath: string,
  callback: (enabled: boolean) => void,
): void {
  const path = GLib.build_filenamev([extensionPath, ".env"]);
  Gio.File.new_for_path(path).load_contents_async(null, (file, result) => {
    let contents: string;
    try {
      const [, bytes] = file!.load_contents_finish(result);
      contents = new TextDecoder().decode(bytes);
    } catch {
      callback(false); // No .env shipped with this build — the common case.
      return;
    }
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      if (trimmed.slice(0, eq).trim() === "CLAUDEWATCH_DEV") {
        callback(trimmed.slice(eq + 1).trim() === "1");
        return;
      }
    }
    callback(false);
  });
}


// Owns the panel indicator (`this.button`, a plain `PanelMenu.Button` — not
// subclassed, since GJS's GObject-subclassing ceremony buys nothing here
// over composition), the row of per-session AgentLabels inside it, and the
// popup menu: the "Claude Usage" section (a single button that opens the
// opt-in, terminal-based rate-limit check). extension.js only owns
// directory-watching wiring and hands this class parsed per-session state
// via applyStates().
export class ClaudeWatchIndicator {
  button: InstanceType<typeof PanelMenu.Button>;

  private readonly _uuid: string;
  // Cancels an in-flight "Show usage" D-Bus call if the extension is
  // disabled before it answers.
  private readonly _cancellable = new Gio.Cancellable();
  private readonly _box: InstanceType<typeof St.BoxLayout>;
  private readonly _standbyLabel: InstanceType<typeof St.Label>;
  private readonly _overflowLabel: InstanceType<typeof St.Label>;
  // `PanelMenu.Button.menu` is typed as `PopupMenu | PopupDummyMenu` since
  // the ambient types don't narrow on the dontCreateMenu constructor arg;
  // it's always a real PopupMenu here since we pass `false` below.
  private readonly _menu: PopupMenu.PopupMenu;

  private readonly _notificationsItem: InstanceType<
    typeof PopupMenu.PopupSwitchMenuItem
  >;
  private readonly _showUsageItem: InstanceType<typeof PopupMenu.PopupMenuItem>;
  // Hidden until "Show usage" finds the D-Bus service missing; clicking it
  // copies the install commands to the clipboard.
  private readonly _usageHintItem: InstanceType<typeof PopupMenu.PopupMenuItem>;
  private readonly _raiseIssueItem: InstanceType<
    typeof PopupMenu.PopupMenuItem
  >;
  private readonly _viewSourceItem: InstanceType<
    typeof PopupMenu.PopupMenuItem
  >;
  private readonly _discussionsItem: InstanceType<
    typeof PopupMenu.PopupMenuItem
  >;
  private readonly _exitItem: InstanceType<typeof PopupMenu.PopupMenuItem>;

  private readonly _onSessionRetired: (sessionId: string) => void;
  private _notificationsEnabled = true;
  private readonly _agents = new Map<string, AgentLabel>();
  // Insertion order, oldest first — determines which sessions show inline
  // vs. fold into the overflow chip once there are more than
  // MAX_INLINE_AGENTS live at once.
  private readonly _order: string[] = [];

  // Dev-only visual QA aid, populated by the CLAUDEWATCH_DEV preview menu
  // built in the constructor below. Deliberately kept out of `_agents`/
  // `_order`: those two drive every read of real on-disk session state
  // (applyStates(), _syncBox(), handleMissing() on a vanished file), so a
  // synthetic preview "session" living in there could get silently retired
  // the moment any real session's file change triggers the next disk scan.
  private _previewLabel: AgentLabel | null = null;
  private _previewActor: InstanceType<typeof St.Label> | null = null;
  // Extra inline AgentLabels for the "overflow" preview only — it shows two
  // full running labels ahead of the "+N more" chip (held in _previewActor
  // above) so the chip's neighboring context is visible too, not just the
  // chip in isolation.
  private readonly _previewOverflowLabels: AgentLabel[] = [];

  constructor(
    uuid: string,
    name: string,
    extensionPath: string,
    onSessionRetired: (sessionId: string) => void,
  ) {
    this._uuid = uuid;
    this._onSessionRetired = onSessionRetired;

    this.button = new PanelMenu.Button(0.0, name, false);
    this._menu = this.button.menu as PopupMenu.PopupMenu;

    this._box = new St.BoxLayout({ style: "spacing: 4px;" });
    this.button.add_child(this._box);

    this._standbyLabel = new St.Label({
      text: STANDBY_TEXT,
      y_align: Clutter.ActorAlign.CENTER,
      style: STANDBY_STYLE,
    });
    this._box.add_child(this._standbyLabel);

    this._overflowLabel = new St.Label({
      y_align: Clutter.ActorAlign.CENTER,
      style: OVERFLOW_STYLE,
      visible: false,
    });
    this._box.add_child(this._overflowLabel);

    // Fixed width so the menu doesn't reflow as row text changes length
    // (e.g. the install hint or a long error string).
    this._menu.box.style = "width: 300px; min-width: 300px; max-width: 300px;";

    this._menu.addMenuItem(
      new PopupMenu.PopupSeparatorMenuItem("Claude Usage"),
    );

    this._showUsageItem = new PopupMenu.PopupMenuItem(USAGE_LABEL);
    // Default activate() chains to super.activate(), which PopupMenu treats
    // as a close-triggering click; override so clicking never closes the
    // menu.
    this._showUsageItem.activate = () => this._onShowUsageClicked();
    this._showUsageItem.label.clutter_text.set({
      line_wrap: true,
      line_wrap_mode: Pango.WrapMode.WORD_CHAR,
    });
    this._menu.addMenuItem(this._showUsageItem);

    this._usageHintItem = new PopupMenu.PopupMenuItem(USAGE_HINT_TEXT);
    this._usageHintItem.visible = false;
    this._usageHintItem.activate = () => this._onUsageHintClicked();
    this._usageHintItem.label.clutter_text.set({
      line_wrap: true,
      line_wrap_mode: Pango.WrapMode.WORD_CHAR,
    });
    this._menu.addMenuItem(this._usageHintItem);
    // The hint is only relevant to the click that triggered it; don't show a
    // stale one the next time the menu opens.
    this._menu.connect("open-state-changed", (_menu, open: boolean) => {
      if (!open) this._usageHintItem.visible = false;
    });

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem("Settings"));

    this._notificationsItem = new PopupMenu.PopupSwitchMenuItem(
      "Notifications",
      true,
    );
    this._notificationsItem.connect("toggled", (_item, state: boolean) => {
      this._notificationsEnabled = state;
    });
    this._notificationsItem.activate = () => this._notificationsItem.toggle();
    this._menu.addMenuItem(this._notificationsItem);

    this._menu.addMenuItem(
      new PopupMenu.PopupSeparatorMenuItem("Help & Feedback"),
    );

    this._raiseIssueItem = new PopupMenu.PopupMenuItem("Raise an issue");
    this._raiseIssueItem.connect("activate", () =>
      Gio.AppInfo.launch_default_for_uri(
        "https://github.com/yevhen-chernenko/claudewatch/issues",
        null,
      ),
    );
    this._menu.addMenuItem(this._raiseIssueItem);

    this._discussionsItem = new PopupMenu.PopupMenuItem("Discussions");
    this._discussionsItem.connect("activate", () =>
      Gio.AppInfo.launch_default_for_uri(
        "https://github.com/yevhen-chernenko/claudewatch/discussions",
        null,
      ),
    );
    this._menu.addMenuItem(this._discussionsItem);

    this._viewSourceItem = new PopupMenu.PopupMenuItem("View source on GitHub");
    this._viewSourceItem.connect("activate", () =>
      Gio.AppInfo.launch_default_for_uri(
        "https://github.com/yevhen-chernenko/claudewatch",
        null,
      ),
    );
    this._menu.addMenuItem(this._viewSourceItem);

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._exitItem = new PopupMenu.PopupMenuItem("Exit ClaudeWatch");
    this._exitItem.connect("activate", () => this._onExit());
    this._menu.addMenuItem(this._exitItem);

    // Visual QA only — lets every panel look (including ones that normally
    // need a real live session, like "complete"'s green flash) be pulled up
    // on demand for screenshots, without a real hook event or session file.
    // Gated on readDevModeFlagAsync() rather than shipped unconditionally so
    // it can never appear for a real user: nothing here reads real session
    // state, and _setPreviewState()/_clearPreview() only ever touch the
    // dev-only _previewLabel/_previewActor fields, never `_agents`/`_order`.
    readDevModeFlagAsync(extensionPath, (enabled) => {
      if (!enabled) return;
      this._menu.addMenuItem(
        new PopupMenu.PopupSeparatorMenuItem("Dev: preview state"),
      );
      const previewItems: { label: string; kind: PreviewKind }[] = [
        { label: "Standby / clear preview", kind: "standby" },
        { label: "Running", kind: "running" },
        { label: "Waiting", kind: "waiting" },
        { label: "Compacting", kind: "compacting" },
        { label: "Consulting", kind: "consulting" },
        { label: "Complete", kind: "complete" },
        { label: "Multi-agent & overflow", kind: "overflow" },
      ];
      for (const { label, kind } of previewItems) {
        const item = new PopupMenu.PopupMenuItem(label);
        // Default activate() (unlike _showUsageItem's/_notificationsItem's
        // overridden one above) closes the menu same as Exit/View source —
        // wanted here so the panel is unobstructed right after picking a
        // state, ready to screenshot.
        item.connect("activate", () => this._setPreviewState(kind));
        this._menu.addMenuItem(item);
      }
    });
  }

  // Called by extension.js with every session's freshly-parsed state-file
  // contents every time the sessions directory changes — one entry per
  // sessions/<session_id>.json file currently on disk, keyed by session id.
  applyStates(states: ReadonlyMap<string, SessionState>): void {
    for (const [sessionId, label] of this._agents) {
      if (!states.has(sessionId)) label.handleMissing();
    }

    for (const [sessionId, state] of states) {
      const existing = this._agents.get(sessionId);
      if (existing) {
        existing.applyState(state, false);
        continue;
      }
      const status = deriveEffectiveStatus(
        state.status,
        isSessionAlive(state),
        isStale(state),
      );
      if (
        status !== "running" &&
        status !== "waiting_approval" &&
        status !== "compacting" &&
        status !== "waiting_background"
      ) {
        continue; // Not a session worth showing a fresh label for.
      }
      this._createAgent(sessionId, state);
    }

    this._syncBox();
  }

  private _createAgent(sessionId: string, state: SessionState): void {
    const namesInUse = new Set(
      Array.from(this._agents.values(), (agent) => agent.agentName),
    );
    const agentName = pickAgentName(namesInUse);
    const label = new AgentLabel(
      sessionId,
      agentName,
      (text, sound) => this._notify(text, sound),
      () => this._retireAgent(sessionId),
    );
    this._agents.set(sessionId, label);
    this._order.push(sessionId);
    // Parent the actor into the box before running applyState() below so
    // the very first ease() (from _enterRunning()/_enterCompacting() inside
    // it) has somewhere on-stage to animate rather than resolving instantly.
    this._syncBox();
    label.applyState(state, true);
  }

  private _retireAgent(sessionId: string): void {
    const label = this._agents.get(sessionId);
    if (!label) return;
    label.destroy();
    this._agents.delete(sessionId);
    const orderIndex = this._order.indexOf(sessionId);
    if (orderIndex !== -1) this._order.splice(orderIndex, 1);
    this._syncBox();
    this._onSessionRetired(sessionId);
  }

  // Shows every live session's label up to MAX_INLINE_AGENTS, folding the
  // rest into a single "+N more" chip, or the standby "Agents are recovering ☕" label
  // when nothing is live.
  private _syncBox(): void {
    const count = this._order.length;
    // Skip while a dev preview is on screen — real disk-driven refreshes
    // (the periodic timer, the sessions-dir file monitor) call this on their
    // own schedule regardless of preview state, and would otherwise flip
    // standby back on under a preview since real count is normally 0 during
    // dev-menu testing. _setPreviewState()/_clearPreview() own standby
    // visibility for the duration of a preview instead.
    if (!this._previewLabel && !this._previewActor) {
      this._standbyLabel.visible = count === 0;
    }
    for (const [index, sessionId] of this._order.entries()) {
      const label = this._agents.get(sessionId);
      if (!label) continue;
      if (!label.actor.get_parent()) {
        this._box.add_child(label.actor);
        this._box.set_child_below_sibling(label.actor, this._overflowLabel);
      }
      label.actor.visible = index < MAX_INLINE_AGENTS;
    }
    const overflowCount = count - MAX_INLINE_AGENTS;
    this._overflowLabel.visible = overflowCount > 0;
    if (overflowCount > 0) {
      this._overflowLabel.set_text(`+${overflowCount} more`);
    }
  }

  // Drives the dev-only preview menu built in the constructor. Reuses
  // AgentLabel itself (rather than reimplementing its styles/text/pulsing)
  // so a preview can never drift from what a real session actually looks
  // like — it's fed a synthetic SessionState instead of one read off disk,
  // going through the exact same applyState() a real disk-driven refresh
  // uses, but the resulting label is never added to `_agents`/`_order`, so
  // the real applyStates()/handleMissing() path can never see or retire it.
  private _setPreviewState(kind: PreviewKind): void {
    this._clearPreview();
    if (kind === "standby") return;
    // Previewing any non-standby state should show only that preview, not
    // the standby label alongside it — _clearPreview() above just restored
    // standby visibility based on real session count, which is normally 0
    // during dev-menu clicking, so it needs hiding again here.
    this._standbyLabel.visible = false;
    if (kind === "overflow") {
      for (const name of ["Smith", "Anderson"]) {
        const label = new AgentLabel(
          `__preview_overflow_${name}__`,
          name,
          () => {},
          () => this._clearPreview(),
        );
        this._box.add_child(label.actor);
        this._box.set_child_below_sibling(label.actor, this._overflowLabel);
        label.applyState({ status: "running" }, true);
        this._previewOverflowLabels.push(label);
      }
      this._previewActor = new St.Label({
        text: "+2 more",
        y_align: Clutter.ActorAlign.CENTER,
        style: OVERFLOW_STYLE,
      });
      this._box.add_child(this._previewActor);
      this._box.set_child_below_sibling(
        this._previewActor,
        this._overflowLabel,
      );
      return;
    }
    this._previewLabel = new AgentLabel(
      "__preview__",
      "Smith",
      () => {}, // No desktop notification/sound spam while clicking through states.
      () => this._clearPreview(),
    );
    this._box.add_child(this._previewLabel.actor);
    this._box.set_child_below_sibling(
      this._previewLabel.actor,
      this._overflowLabel,
    );
    if (kind === "complete") {
      // resolveUiAction() only fires the green flash on a status -> "done"
      // *edge*, not on a first-ever refresh (see its isInitialRefresh branch
      // in state.ts) — so previewing the real flash+auto-retire needs a
      // running start state first, then a second call that actually crosses
      // the edge, same as a real session finishing a turn.
      this._previewLabel.applyState({ status: "running" }, true);
      this._previewLabel.applyState({ status: "done" }, false);
      return;
    }
    const statusForKind: Record<
      Exclude<PreviewKind, "standby" | "overflow" | "complete">,
      string
    > = {
      running: "running",
      waiting: "waiting_approval",
      compacting: "compacting",
      consulting: "waiting_background",
    };
    const state: SessionState = { status: statusForKind[kind] };
    this._previewLabel.applyState(state, true);
  }

  private _clearPreview(): void {
    if (this._previewLabel) {
      this._previewLabel.destroy();
      this._previewLabel = null;
    }
    if (this._previewActor) {
      this._previewActor.destroy();
      this._previewActor = null;
    }
    for (const label of this._previewOverflowLabels) label.destroy();
    this._previewOverflowLabels.length = 0;
    // Restore standby to whatever real session count says it should be —
    // covers both an explicit "Standby / clear preview" click and the
    // "complete" preview auto-retiring itself via _onRetired() after its
    // flash, neither of which should leave the standby label hidden.
    this._standbyLabel.visible = this._order.length === 0;
  }

  // Desktop notification paired with a themed system sound — every waiting/
  // complete transition fires both together. Uses the shell's own sound
  // player (same mechanism as the screenshot/volume sounds) rather than
  // spawning a subprocess, and resolves soundName against the user's
  // current sound theme rather than shipping an audio file. No-op unless
  // the "Notifications" toggle is on (default on).
  private _notify(text: string, soundName: string): void {
    if (!this._notificationsEnabled) return;
    Main.notify("ClaudeWatch", text);
    global.display.get_sound_player().play_from_theme(soundName, text, null);
  }

  // Asks the claudewatch-usage D-Bus service (a separate pip package, see
  // usage/ — extensions must not bundle scripts that need to be installed,
  // and installing anything needs explicit user action) to open its terminal
  // view: the opt-in rate-limit check (see
  // SECURITY.md#opt-in-network-egress-the-rate-limit-check), read from a
  // terminal since this is the only usage source in the menu. The extension
  // spawns nothing itself; the service owns picking and launching the
  // terminal. If the name isn't running and can't be bus-activated, the
  // service simply isn't installed yet.
  private _onShowUsageClicked(): void {
    Gio.DBus.session.call(
      USAGE_BUS_NAME,
      USAGE_OBJECT_PATH,
      USAGE_INTERFACE,
      "Show",
      null,
      null,
      Gio.DBusCallFlags.NONE,
      USAGE_CALL_TIMEOUT_MS,
      this._cancellable,
      (connection, result) => {
        try {
          connection!.call_finish(result);
          this._showUsageItem.label.set_text(USAGE_LABEL);
          this._usageHintItem.visible = false;
        } catch (e) {
          if (
            e instanceof GLib.Error &&
            e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)
          ) {
            return;
          }
          if (this._isServiceMissing(e)) {
            this._showUsageItem.label.set_text(USAGE_LABEL);
            this._usageHintItem.label.set_text(USAGE_HINT_TEXT);
            this._usageHintItem.visible = true;
            return;
          }
          this._usageHintItem.visible = false;
          this._showUsageItem.label.set_text(this._usageErrorLabel(e));
        }
      },
    );
  }

  private _isServiceMissing(e: unknown): boolean {
    if (!(e instanceof GLib.Error) || !Gio.DBusError.is_remote_error(e)) {
      return false;
    }
    const remote = Gio.DBusError.get_remote_error(e);
    return (
      remote === "org.freedesktop.DBus.Error.ServiceUnknown" ||
      remote === "org.freedesktop.DBus.Error.NameHasNoOwner"
    );
  }

  private _usageErrorLabel(e: unknown): string {
    if (e instanceof GLib.Error && Gio.DBusError.is_remote_error(e)) {
      Gio.DBusError.strip_remote_error(e);
    }
    return `${USAGE_LABEL} — ${e instanceof Error ? e.message : String(e)}`;
  }

  private _onUsageHintClicked(): void {
    // Both selections: CLIPBOARD for Ctrl+V, PRIMARY for middle-click paste.
    const clipboard = St.Clipboard.get_default();
    clipboard.set_text(St.ClipboardType.CLIPBOARD, USAGE_INSTALL_HINT);
    clipboard.set_text(St.ClipboardType.PRIMARY, USAGE_INSTALL_HINT);
    this._usageHintItem.label.set_text(USAGE_HINT_COPIED_TEXT);
  }

  private _onExit(): void {
    const settings = new Gio.Settings({ schema_id: "org.gnome.shell" });
    const enabled = settings.get_strv("enabled-extensions");
    const index = enabled.indexOf(this._uuid);
    if (index === -1) return;
    enabled.splice(index, 1);
    settings.set_strv("enabled-extensions", enabled);
  }

  // Scoped to what this class owns: each AgentLabel's pending GLib timeout
  // is the thing that actually leaks across enable/disable cycles if left
  // connected — destroying `button` (a widget) takes its child actors and
  // menu items with it.
  destroy(): void {
    this._cancellable.cancel();
    this._clearPreview();
    for (const label of this._agents.values()) label.destroy();
    this._agents.clear();
    this._order.length = 0;
    // Nothing reads `button` after this call — extension.js drops its own
    // reference to this indicator in the same disable() that calls
    // destroy() — so there's no need to null it out here.
    this.button.destroy();
  }
}
