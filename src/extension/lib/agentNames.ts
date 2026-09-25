// SPDX-License-Identifier: GPL-2.0-or-later

// Picked once per session (when its label is first created) and reused for
// every status text until the session retires, so "Agent Smith" stays
// "Agent Smith" across running/waiting/complete instead of re-rolling on
// every state-file update. Concurrent sessions avoid picking the same name
// as each other where possible — see pickAgentName() below.
const AGENT_NAMES = [
  "Smith",
  "Johnson",
  "Thompson",
  "Jackson",
  "Wilson",
  "Anderson",
  "Robertson",
  "Peterson",
  "Nelson",
  "Watson",
];

// Picks a name for a newly-seen session, avoiding names already in use by
// other concurrently-live sessions where possible. Falls back to a numbered
// suffix on the fixed list's first name once every name is already taken
// (an 11th+ concurrent session) rather than silently duplicating a name.
export function pickAgentName(namesInUse: ReadonlySet<string>): string {
  const available = AGENT_NAMES.filter((name) => !namesInUse.has(name));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)]; //NOSONAR - cosmetic name pick, not security-sensitive
  }
  let suffix = 2;
  let candidate = `${AGENT_NAMES[0]} ${suffix}`;
  while (namesInUse.has(candidate)) {
    suffix += 1;
    candidate = `${AGENT_NAMES[0]} ${suffix}`;
  }
  return candidate;
}
