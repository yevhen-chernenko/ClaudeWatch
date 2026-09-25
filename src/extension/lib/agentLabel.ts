// SPDX-License-Identifier: GPL-2.0-or-later

import St from "gi://St";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Clutter from "gi://Clutter";

import {
  resolveUiAction,
  deriveEffectiveStatus,
  type SessionState,
} from "./state.js";
import {
  COMPACTING_STALE_MS,
  CONSULTING_STALE_MS,
  isSessionAlive,
  isStale,
} from "./staleness.js";

const runningText = (name: string) => `Agent ${name} is working 🕶️`;
const waitingText = (name: string) => `Agent ${name} needs support 📞`;
const completeText = (name: string) => `Agent ${name} is done 🎖️`;
const consultingText = (name: string) => `Agent ${name} is consulting notes 📓`;
const COMPACTING_TEXT = "Agents are training 🔫"; // no agent name — it isn't retained into the next session

// Backgrounds are all white-text-on-color, AA-contrast checked (≥4.5:1
// against #ffffff at this weight/size).
const RUNNING_STYLE =
  "padding: 0 6px; background-color: #a0450a; border-radius: 4px; color: #ffffff;"; // 6.27:1
const WAITING_STYLE =
  "padding: 0 6px; background-color: #2457c5; border-radius: 4px; color: #ffffff;"; // 6.47:1
const COMPLETE_STYLE =
  "padding: 0 6px; background-color: #1a7a43; border-radius: 4px; color: #ffffff;"; // 5.37:1
const COMPACTING_STYLE =
  "padding: 0 6px; background-color: #7a3fa0; border-radius: 4px; color: #ffffff;"; // 6.89:1
const CONSULTING_STYLE =
  "padding: 0 6px; background-color: #7a5f00; border-radius: 4px; color: #ffffff;"; // 6.06:1
const COMPLETE_FLASH_MS = 5000;
// Full pulse cycle (dim -> bright -> dim) is 2x this, i.e. 2.6s; opacity
// floor is 72% of 255.
const PULSE_HALF_CYCLE_MS = 1300;
const PULSE_DIM_OPACITY = Math.round(255 * 0.72);

export type UiState = "running" | "waiting" | "complete" | "compacting" | "consulting";

// Actor's `ease()` is JS-side sugar from environment.js (not
// GIR-introspected, so ts-for-gir never sees it) — a real GNOME Shell API
// the community @girs types don't model. A `declare module` augmentation of
// the generated `@girs/*` packages was tried first and corrupted unrelated
// type resolution for those packages under this toolchain's module setup,
// so this stays as a narrow local assertion instead of a global ambient
// patch.
type Easeable = {
  ease(properties: {
    opacity?: number;
    duration?: number;
    mode?: Clutter.AnimationMode;
    onComplete?: () => void;
  }): void;
};

// One live Claude Code session's panel label and notification/pulse state
// machine. Created when a session first reports a
// running/waiting_approval/compacting status, destroyed when it retires
// (task done and the post-completion flash has elapsed, or the session goes
// away/dies without ever finishing cleanly). Owns exactly the per-session
// slice of what the single-session ClaudeWatchIndicator used to own itself.
export class AgentLabel {
  readonly sessionId: string;
  readonly actor: InstanceType<typeof St.Label>;
  readonly agentName: string;

  private readonly _notify: (text: string, soundName: string) => void;
  private readonly _onRetired: () => void;

  private _uiState: UiState = "running";
  private _lastStatus: string | null = null;
  private _state: SessionState = {};
  private _pulseDim = false;
  private _flashTimeoutId: number | null = null;
  private _compactingTimeoutId: number | null = null;
  private _consultingTimeoutId: number | null = null;
  private _pulseTimeoutId: number | null = null;
  private _transcriptMonitor: Gio.FileMonitor | null =
    null;
  private _transcriptMonitorId: number | null = null;
  private _transcriptWatchFile: Gio.File | null = null;
  private _transcriptWatchStartLength = 0;

  constructor(
    sessionId: string,
    agentName: string,
    notify: (text: string, soundName: string) => void,
    onRetired: () => void,
  ) {
    this.sessionId = sessionId;
    this.agentName = agentName;
    this._notify = notify;
    this._onRetired = onRetired;
    // Placeholder only — applyState() runs synchronously right after
    // construction (see ClaudeWatchIndicator._createAgent()) and always
    // overwrites this before it's ever painted.
    this.actor = new St.Label({
      y_align: Clutter.ActorAlign.CENTER,
      style: RUNNING_STYLE,
      text: "",
    });
  }

  get state(): SessionState {
    return this._state;
  }

  get uiState(): UiState {
    return this._uiState;
  }

  // Called with this session's freshly-parsed state-file contents every
  // time the sessions directory changes. Edge-triggered on status
  // transitions via resolveUiAction(), same rules as the single-session
  // version — see its comment in lib/state.ts.
  applyState(state: SessionState, isInitial: boolean): void {
    this._state = state;
    const status = deriveEffectiveStatus(
      state.status,
      isSessionAlive(state),
      isStale(state),
    );
    const action = resolveUiAction(status, this._lastStatus, isInitial);
    this._lastStatus = status ?? null;
    if (action === "running") this._enterRunning();
    else if (action === "waiting") this._enterWaiting();
    else if (action === "compacting") this._enterCompacting();
    else if (action === "consulting") this._enterConsulting();
    else if (action === "complete") this._enterComplete();
    else if (action === "standby") {
      // Not a fresh "done" — the session went away without a clean finish
      // (process killed, crashed). No green flash for that, straight to
      // retirement, same as the single-session version snapping to standby.
      this._retire();
      return;
    }
    // Arm only on the transition into "compacting", not on every repeat
    // tick — the directory monitor re-dispatches this session's state on
    // *any* session's file changing, so arming unconditionally on raw
    // status would keep resetting the fallback clock off the back of
    // unrelated sessions' activity and it would never elapse.
    if (action === "compacting") {
      this._armCompactingTimeout();
      this._watchTranscriptForCompactOutcome();
    } else if (status !== "compacting") {
      this._clearCompactingTimeout();
      this._stopWatchingTranscript();
    }
    // Same arm-on-entry-only rule as compacting above, and for the same
    // reason: re-arming on every repeat tick (fired by any session's file
    // changing, not just this one's) would keep pushing the fallback clock
    // out and it would never elapse.
    if (action === "consulting") this._armConsultingTimeout();
    else if (status !== "waiting_background") this._clearConsultingTimeout();
  }

  // The session's file disappeared from the directory entirely (SessionEnd
  // cleanup, or a manual/external delete) rather than reporting a new
  // status. A no-op while already mid-complete-flash — that timer already
  // owns retirement, and a vanished file doesn't need to race it.
  handleMissing(): void {
    if (this._uiState === "complete") return;
    this._retire();
  }

  private _enterRunning(): void {
    this._uiState = "running";
    this._clearFlashTimeout();
    this._clearPulseTimeout();
    this.actor.style = RUNNING_STYLE;
    this.actor.set_text(runningText(this.agentName));
    this.actor.opacity = 255;
    this._pulseDim = false;
    this._pulseLoop();
  }

  private _enterWaiting(): void {
    this._uiState = "waiting";
    this._clearFlashTimeout();
    this._clearPulseTimeout();
    this.actor.remove_all_transitions();
    this.actor.style = WAITING_STYLE;
    const text = waitingText(this.agentName);
    this.actor.set_text(text);
    this.actor.opacity = 255;
    this._notify(text, "dialog-question");
  }

  private _enterCompacting(): void {
    this._uiState = "compacting";
    this._clearFlashTimeout();
    this._clearPulseTimeout();
    this.actor.style = COMPACTING_STYLE;
    this.actor.set_text(COMPACTING_TEXT);
    this.actor.opacity = 255;
    this._pulseDim = false;
    this._pulseLoop();
  }

  // A Stop landed while a subagent this session spawned hasn't reported back
  // via SubagentStop yet (waiting_background — see hooks/lib/status.ts).
  // Pulses like running/compacting since this is genuine ongoing work, just
  // not visible in the transcript the same way; unlike "waiting" it isn't a
  // request for the user, so no notification fires.
  private _enterConsulting(): void {
    this._uiState = "consulting";
    this._clearFlashTimeout();
    this._clearPulseTimeout();
    this.actor.style = CONSULTING_STYLE;
    this.actor.set_text(consultingText(this.agentName));
    this.actor.opacity = 255;
    this._pulseDim = false;
    this._pulseLoop();
  }

  // Just-finished state: flashes the label green for COMPLETE_FLASH_MS,
  // then retires (removes) the label entirely — unlike the single-session
  // version there's no shared standby state to fall back to; "Agents are recovering ☕"
  // only appears once every session has retired.
  private _enterComplete(): void {
    this._uiState = "complete";
    this.actor.remove_all_transitions();
    this._clearFlashTimeout();
    this._clearPulseTimeout();
    this.actor.opacity = 255;
    this.actor.style = COMPLETE_STYLE;
    const text = completeText(this.agentName);
    this.actor.set_text(text);
    this._notify(text, "complete");
    this._flashTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      COMPLETE_FLASH_MS,
      () => {
        this._flashTimeoutId = null;
        this._retire();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  private _retire(): void {
    this._onRetired();
  }

  private _clearFlashTimeout(): void {
    if (this._flashTimeoutId) {
      GLib.source_remove(this._flashTimeoutId);
      this._flashTimeoutId = null;
    }
  }

  private _armCompactingTimeout(): void {
    this._clearCompactingTimeout();
    this._compactingTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      COMPACTING_STALE_MS,
      () => {
        this._compactingTimeoutId = null;
        if (this._uiState === "compacting") this._retire();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  private _armConsultingTimeout(): void {
    this._clearConsultingTimeout();
    this._consultingTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      CONSULTING_STALE_MS,
      () => {
        this._consultingTimeoutId = null;
        if (this._uiState === "consulting") this._retire();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  private _clearConsultingTimeout(): void {
    if (this._consultingTimeoutId) {
      GLib.source_remove(this._consultingTimeoutId);
      this._consultingTimeoutId = null;
    }
  }

  private _clearCompactingTimeout(): void {
    if (this._compactingTimeoutId) {
      GLib.source_remove(this._compactingTimeoutId);
      this._compactingTimeoutId = null;
    }
  }

  private _watchTranscriptForCompactOutcome(): void {
    const transcriptPath = this._state.transcript_path;
    if (!transcriptPath) {
      this._stopWatchingTranscript();
      return;
    }
    const file = Gio.File.new_for_path(transcriptPath);
    file.load_contents_async(null, (_file: Gio.File | null, result: Gio.AsyncResult) => {
      let startLength = 0;
      try {
        const [, contents] = file.load_contents_finish(result);
        startLength = new TextDecoder().decode(contents).length;
      } catch {
        // Transcript not there yet — watch from the start so nothing
        // already-written can hide a fresh marker.
      }
      if (this._uiState !== "compacting") return;
      this._stopWatchingTranscript();
      this._transcriptWatchStartLength = startLength;
      this._transcriptWatchFile = file;
      this._transcriptMonitor = file.monitor_file(
        Gio.FileMonitorFlags.NONE,
        null,
      );
      this._transcriptMonitorId = this._transcriptMonitor.connect(
        "changed",
        () => this._checkTranscriptForCompactOutcome(),
      );
    });
  }

  private _checkTranscriptForCompactOutcome(): void {
    const file = this._transcriptWatchFile;
    if (!file || this._uiState !== "compacting") return;
    file.load_contents_async(null, (_file: Gio.File | null, result: Gio.AsyncResult) => {
      if (this._uiState !== "compacting" || this._transcriptWatchFile !== file)
        return;
      let contents: string;
      try {
        const [, bytes] = file.load_contents_finish(result);
        contents = new TextDecoder().decode(bytes);
      } catch {
        return; // Mid-write; the next "changed" event retries.
      }
      if (contents.length <= this._transcriptWatchStartLength) return;
      const appended = contents.slice(this._transcriptWatchStartLength);
      for (const line of appended.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: { type?: string; subtype?: string; content?: unknown };
        try {
          entry = JSON.parse(trimmed);
        } catch {
          continue; // Partial line mid-write; keep waiting.
        }
        if (entry.type !== "system") continue;
        const isAbort =
          entry.subtype === "local_command" &&
          typeof entry.content === "string" &&
          entry.content.includes("AbortError: Compaction canceled.");
        if (entry.subtype === "compact_boundary" || isAbort) {
          this._retire();
          return;
        }
      }
    });
  }

  private _stopWatchingTranscript(): void {
    if (this._transcriptMonitor && this._transcriptMonitorId) {
      this._transcriptMonitor.disconnect(this._transcriptMonitorId);
    }
    this._transcriptMonitor = null;
    this._transcriptMonitorId = null;
    this._transcriptWatchFile = null;
  }

  private _clearPulseTimeout(): void {
    if (this._pulseTimeoutId) {
      GLib.source_remove(this._pulseTimeoutId);
      this._pulseTimeoutId = null;
    }
  }

  // Only "running" and "compacting" pulse — "waiting" reads clearly enough
  // from its color/text alone and stays static, same as "complete". Driven
  // by GLib.timeout_add rather than ease()'s onComplete: an actor that
  // isn't mapped (hidden past MAX_INLINE_AGENTS, or mid-teardown) makes
  // Clutter resolve ease() synchronously, and onComplete recursing straight
  // back into _pulseLoop() from inside that same synchronous call blows the
  // stack ("too much recursion") instead of ticking over real time. A
  // GLib timeout always defers to the main loop regardless of the actor's
  // mapped state, so this can't recurse no matter what.
  private _pulseLoop(): void {
    if (
      this._uiState !== "running" &&
      this._uiState !== "compacting" &&
      this._uiState !== "consulting"
    )
      return;
    this._pulseDim = !this._pulseDim;
    (this.actor as unknown as Easeable).ease({
      opacity: this._pulseDim ? PULSE_DIM_OPACITY : 255,
      duration: PULSE_HALF_CYCLE_MS,
      mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
    });
    this._pulseTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      PULSE_HALF_CYCLE_MS,
      () => {
        this._pulseTimeoutId = null;
        this._pulseLoop();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  destroy(): void {
    this._clearFlashTimeout();
    this._clearCompactingTimeout();
    this._clearConsultingTimeout();
    this._clearPulseTimeout();
    this._stopWatchingTranscript();
    this.actor.remove_all_transitions();
    this.actor.destroy();
  }
}
