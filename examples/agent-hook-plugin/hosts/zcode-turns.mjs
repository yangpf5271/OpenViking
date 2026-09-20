/**
 * Pure transcript parser for ZCode hook events.
 *
 * ZCode's Stop hook stdin payload is not fully documented. Based on
 * reverse-engineering (#3127 by @quinn-zenith) and rollout file analysis,
 * the Stop payload contains at least:
 *   - session_id / sessionId
 *   - cwd
 *   - transcript_path (points to a TEMP file with only the LAST assistant
 *     message — NOT a complete conversation)
 *   - responseText / responsePreview (the last assistant response text)
 *
 * The rollout files at ~/.zcode/cli/rollout/model-io-*.jsonl contain
 * the COMPLETE conversation with this structure per line:
 *   { sessionId, turnId, type: "model_io",
 *     request: { messages: [{ role, content }] },
 *     response: { text, toolCalls, finishReason } }
 *
 * Strategy:
 * 1. Use the rollout file as the authoritative incremental transcript and
 *    extract ALL unseen turns since the last acknowledged turnId.
 * 2. Use stdin + pendingPrompt only when the rollout file is unavailable.
 */

import fs from "node:fs";
import { join } from "node:path";

const INJECTED_BLOCK_RE = /<openviking-context\b[^>]*>[\s\S]*?<\/openviking-context>/gi;
const RELEVANT_MEMORIES_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>/gi;
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;

/**
 * Strip plugin-injected blocks and trim whitespace.
 */
export function cleanZcodeText(value) {
  return String(value || "")
    .replace(INJECTED_BLOCK_RE, "")
    .replace(RELEVANT_MEMORIES_RE, "")
    .replace(SYSTEM_REMINDER_RE, "")
    .trim();
}

/**
 * Resolve the rollout file path for a given session ID.
 * ZCode stores rollout at ~/.zcode/cli/rollout/model-io-<sessionId>.jsonl
 */
function resolveRolloutPath(input = {}) {
  const sessionId =
    input.session_id || input.sessionId || input.conversation_id || "";
  if (!sessionId) return null;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  // ZCode rollout files are named: model-io-<sessionId>.jsonl
  // sessionId already includes the "sess_" prefix, so no extra "sess-" needed.
  return join(home, ".zcode", "cli", "rollout", `model-io-${sessionId}.jsonl`);
}

/**
 * Extract the user message from a rollout entry's request.messages.
 * Finds the last user-role message in the array.
 */
function extractUserFromMessages(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      const content = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((b) => b?.type === "text").map((b) => b.text).join("\n")
          : "";
      const cleaned = cleanZcodeText(content);
      if (cleaned) return cleaned;
      break;
    }
  }
  return "";
}

/**
 * Read ALL unseen turns from a ZCode rollout file since lastKnownTurnId.
 * Each rollout line is a JSON object with turnId, request.messages, response.text.
 *
 * @param {string} rolloutPath - Path to the rollout JSONL file.
 * @param {string} lastKnownTurnId - The last processed turnId (exclusive bound).
 * @returns {Array<{role: string, content: string, turnId: string}>} Unseen turns.
 */
export function extractUnseenRolloutTurns(rolloutPath, lastKnownTurnId = null) {
  return readUnseenRolloutTurns(rolloutPath, lastKnownTurnId).turns;
}

// Long-running sessions grow their rollout into gigabytes; those Stop hooks
// have seconds, not minutes. Scan backwards from the tail in windows and pull
// in turn ids with a regex instead of parsing every line — full-file
// readFileSync + per-line JSON.parse blew the hook timeout and silently
// dropped captures (9.96 GB rollout = every Stop skipped).
const ROLLOUT_WINDOW_BYTES = 8 * 1024 * 1024;
const ROLLOUT_MAX_WINDOW_BYTES = 1024 * 1024 * 1024;
const TURN_ID_RE = /"turnId"\s*:\s*"([^"]+)"/;

function readRolloutSlice(fd, start, length) {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, start);
  return buffer.toString("utf8");
}

function scanWindowForTurnId(lines, wanted) {
  // Index of the line whose turnId equals `wanted`, -1 if absent, or null
  // when the window edge cut a line short (caller widens and retries).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 64 * 1024 * 1024) continue;
    const match = TURN_ID_RE.exec(line);
    if (match && match[1] === wanted) return i;
  }
  return lines.some((line) => line && !line.endsWith("}") && !line.endsWith("]")) ? null : -1;
}

function readUnseenRolloutTurns(rolloutPath, lastKnownTurnId = null) {
  if (!rolloutPath) return { available: false, turns: [] };
  let size = 0;
  try {
    size = fs.statSync(rolloutPath).size;
  } catch {
    return { available: false, turns: [] };
  }
  if (size === 0) return { available: true, turns: [] };

  // Work backwards in growing windows; most Stops only need the last few MB.
  let window = Math.min(ROLLOUT_WINDOW_BYTES, size);
  let lines = null;
  if (lastKnownTurnId) {
    while (true) {
      const start = Math.max(0, size - window);
      const raw = readRolloutSlice(fs.openSync(rolloutPath, "r"), start, size - start);
      const allLines = raw.split("\n").filter(Boolean);
      const found = scanWindowForTurnId(allLines, lastKnownTurnId);
      if (found === null && window < Math.min(ROLLOUT_MAX_WINDOW_BYTES, size)) {
        window = Math.min(window * 4, ROLLOUT_MAX_WINDOW_BYTES, size);
        continue;
      }
      // Found → everything after the cursor is unseen. Not found anywhere →
      // the rollout rotated under us; treat the window as a first capture.
      lines = found >= 0 ? allLines.slice(found + 1) : allLines;
      break;
    }
  } else {
    // No cursor → first-time capture takes the tail window; the earliest
    // entries in a giant rollout are long-gone context anyway.
    const start = Math.max(0, size - window);
    const raw = readRolloutSlice(fs.openSync(rolloutPath, "r"), start, size - start);
    lines = raw.split("\n").filter(Boolean);
  }
  if (lines.length === 0) return { available: true, turns: [] };

  const turns = [];
  const seenUserKeys = new Set();
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const turnId = entry.turnId || "";
    const userContent = extractUserFromMessages(entry?.request?.messages || []);
    const assistantContent = cleanZcodeText(entry?.response?.text || "");
    if (userContent) {
      // One user turn fans out into many model_io entries while the agent
      // runs its tool loop, and every entry's request.messages still ends
      // with the same user prompt. Keep only the first occurrence per
      // (turnId, content) so a single prompt is captured once, not once per
      // model call.
      const userKey = `${turnId}\u0000${userContent}`;
      if (!seenUserKeys.has(userKey)) {
        seenUserKeys.add(userKey);
        turns.push({ role: "user", content: userContent, turnId });
      }
    }
    if (assistantContent) {
      turns.push({ role: "assistant", content: assistantContent, turnId });
    }
  }

  return { available: true, turns };
}

/**
 * Extract user/assistant turns from a ZCode Stop-event payload.
 *
 * Uses the rollout file first so every normal Stop observes stable host turn
 * IDs and can recover missed Stop events. Stdin is only a compatibility
 * fallback for environments where no rollout file can be read.
 *
 * @param {object} input - Raw hook stdin JSON.
 * @param {object} state - Persistent hook state (may contain pendingPrompt, lastTurnId).
 * @returns {Array<{role: string, content: string, turnId?: string}>} Non-empty turns.
 */
export function buildZcodeTurns(input = {}, state = {}) {
  const rolloutPath = resolveRolloutPath(input);
  const rollout = readUnseenRolloutTurns(rolloutPath, state.lastTurnId || null);
  if (rollout.available) return rollout.turns;

  // Assistant content: try documented and reverse-engineered field names
  const assistantContent =
    input.responseText ||
    input.responsePreview ||
    input.last_assistant_message ||
    input.assistantMessage ||
    input.assistant_message ||
    input.text_content ||
    input.response ||
    "";

  // User content: try multiple field names
  const userContent =
    input.prompt ||
    input.user_prompt ||
    input.userMessage ||
    input.user_message ||
    input.last_user_message ||
    input.message ||
    state.pendingPrompt?.prompt ||
    "";

  return [
    { role: "user", content: cleanZcodeText(userContent) },
    { role: "assistant", content: cleanZcodeText(assistantContent) },
  ].filter((turn) => turn.content);
}