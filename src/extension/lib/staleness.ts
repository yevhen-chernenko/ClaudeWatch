// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from "gi://Gio";

import type { SessionState } from "./state.js";

// Claude Code only writes a hook-triggered state-file update for a
// *completed* compaction (PreCompact then, eventually, some later event once
// the session resumes) — cancelling a manual /compact mid-flight fires no
// hook at all, so the directory monitor never wakes this label back up on
// its own. _watchTranscriptForCompactOutcome() below tails the session
// transcript directly for the two markers Claude Code actually writes
// there — a `{"type":"system","subtype":"compact_boundary",...}` entry on a
// real completion, or a local_command entry containing "AbortError:
// Compaction canceled." on a cancel — and reacts within a file-monitor tick
// either way, so this timeout is normally not what the user waits on. It's
// the fallback behind that fast path: if transcript_path is missing or
// those markers ever change shape, this still bounds "compacting" the same
// way COMPLETE_FLASH_MS bounds "complete", so a label can't get stuck
// purple forever. Generous relative to how long even a large-transcript
// compaction realistically takes, so it shouldn't cut a genuine one off
// mid-flight.
export const COMPACTING_STALE_MS = 3 * 60 * 1000;

// Bounds how long a "running" status is trusted once its own file stops
// moving — see deriveEffectiveStatus's isRunningStale param in state.ts for
// why pid-liveness can't catch this on its own (a turn that ends by
// interruption, not a clean Stop, leaves the CLI process alive and idling
// with no further hook ever firing for that session). Deliberately on a
// much longer leash than COMPACTING_STALE_MS: an actual compaction is
// bounded and rare, but a single legitimate tool call (a big test suite, a
// package install) can easily run this long between PreToolUse/PostToolUse
// updates, and this must clear comfortably past that or it'll retire a
// task that's still genuinely in flight.
const RUNNING_STALE_MS = 20 * 60 * 1000;

// Same fallback shape as COMPACTING_STALE_MS above, for the same reason: the
// fast path here is SubagentStop actually firing, but if the tracked
// subagent's process were ever killed outright rather than cleanly
// finishing, no hook fires for that either, and pid-liveness alone can't
// catch it (the parent CLI is still alive and idling). On a longer leash
// than RUNNING_STALE_MS since a real agentic subagent task (e.g. a
// large-codebase Explore) can legitimately run long with no activity
// visible to this session's own file in the meantime.
export const CONSULTING_STALE_MS = 45 * 60 * 1000;

// A recorded pid means the hook that wrote it ran in exec form (no shell
// wrapper), so pid is the Claude Code CLI process itself — /proc/<pid>
// existing is a direct liveness check, not a heuristic. No pid (older state
// file, or none yet) means trust the status as-is. Shared between the
// pre-creation check in ClaudeWatchIndicator.applyStates() and each
// AgentLabel's own per-refresh check, so both apply the exact same rule.
export function isSessionAlive(state: SessionState): boolean {
  const pid = state.pid;
  if (pid == null) return true;
  return Gio.File.new_for_path(`/proc/${pid}`).query_exists(null);
}

// Plain-boolean computation of "has this session's own file gone quiet for
// too long while stuck on running" — see RUNNING_STALE_MS above and
// deriveEffectiveStatus's isStale param in state.ts for why this exists
// alongside isSessionAlive rather than being covered by it.
function isRunningStale(state: SessionState): boolean {
  if (state.status !== "running" || !state.updated_at) return false;
  const updatedAt = Date.parse(state.updated_at);
  if (Number.isNaN(updatedAt)) return false;
  return Date.now() - updatedAt > RUNNING_STALE_MS;
}

// Same shape as isRunningStale, for "compacting"/COMPACTING_STALE_MS and
// "waiting_background"/CONSULTING_STALE_MS respectively. These two statuses
// already have their own fallback via each AgentLabel's private
// _armCompactingTimeout/_armConsultingTimeout GLib timer (see below), but
// that timer is in-memory and only armed on entry into the state — an
// extension or GNOME Shell reload while a label is mid-flight destroys and
// recreates it from scratch, resetting the clock to zero. These file-
// anchored checks close that gap the same way isRunningStale already does
// for "running": fed through deriveEffectiveStatus, they get re-evaluated on
// every applyStates() call, including the periodic re-scan in extension.ts,
// so a session that's genuinely been stale since before a reload is caught
// immediately on the next tick rather than only after a fresh multi-minute
// wait.
function isCompactingStale(state: SessionState): boolean {
  if (state.status !== "compacting" || !state.updated_at) return false;
  const updatedAt = Date.parse(state.updated_at);
  if (Number.isNaN(updatedAt)) return false;
  return Date.now() - updatedAt > COMPACTING_STALE_MS;
}

function isConsultingStale(state: SessionState): boolean {
  if (state.status !== "waiting_background" || !state.updated_at) return false;
  const updatedAt = Date.parse(state.updated_at);
  if (Number.isNaN(updatedAt)) return false;
  return Date.now() - updatedAt > CONSULTING_STALE_MS;
}

// state.status is singular, so at most one of the three checks above can
// ever be true for a given state — this just dispatches to whichever one
// applies before feeding deriveEffectiveStatus's single isStale param.
export function isStale(state: SessionState): boolean {
  return (
    isRunningStale(state) ||
    isCompactingStale(state) ||
    isConsultingStale(state)
  );
}
