#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * A free ACP agent for dev servers. It plays recorded ACP transcripts with simulated
 * streaming, so the real adapter, orchestration, and UI run without a paid model.
 * Each scenario is a "model"; each prompt plays the next recorded turn.
 * Unlike acp-replay-agent.ts, it does not assert the client's frames.
 */
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

interface LogicalFrame {
  readonly kind: "notification" | "request" | "response";
  readonly method: string;
  readonly params?: unknown;
  readonly result?: unknown;
}

interface ReplayEntry {
  readonly type: "emit_inbound" | "expect_outbound" | "runtime_exit" | "transcript_start";
  readonly frame?: LogicalFrame;
  readonly afterMs?: number;
}

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface ReplayTurn {
  /** Frames the agent sends: session updates and agent-to-client requests. */
  readonly frames: ReadonlyArray<{ readonly frame: LogicalFrame; readonly afterMs?: number }>;
  readonly stopReason: string;
}

const FIXTURES = "../src/orchestration-v2/testkit/fixtures";

// Recorded fixtures the replay tests already pin, plus a hand-written UI showcase.
export const SCENARIOS = [
  { id: "showcase", name: "Showcase", file: "./dev-replay/showcase_transcript.ndjson" },
  {
    id: "todo-list",
    name: "Plan and reads",
    file: `${FIXTURES}/todo_list/registry_transcript.ndjson`,
  },
  {
    id: "approval",
    name: "Write approval",
    file: `${FIXTURES}/tool_call_read_only_on_request/grok_transcript.ndjson`,
  },
  {
    id: "background-subagent",
    name: "Background subagent",
    file: `${FIXTURES}/grok_background_subagent/grok_transcript.ndjson`,
  },
  { id: "multi-turn", name: "Multi turn", file: `${FIXTURES}/multi_turn/grok_transcript.ndjson` },
] as const;

// Session setup and vendor state stay out: they would replace the replay agent's own models.
const REPLAYED_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
  "session_info_update",
  "usage_update",
]);

const CHUNK_DELAY_MS = 30;
const FRAME_DELAY_MS = 250;
const MAX_RECORDED_DELAY_MS = 2_000;
const WORDS_PER_CHUNK = 3;

function isReplayedFrame(frame: LogicalFrame): boolean {
  if (frame.kind === "request") return !frame.method.startsWith("_");
  if (frame.kind !== "notification" || frame.method !== "session/update") return false;
  const update = (frame.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update;
  return typeof update?.sessionUpdate === "string" && REPLAYED_UPDATES.has(update.sessionUpdate);
}

/** Splits a recorded transcript into the turns that follow each `session/prompt`. */
export function parseReplayTurns(ndjson: string): ReadonlyArray<ReplayTurn> {
  const turns: Array<{ frames: Array<ReplayTurn["frames"][number]>; stopReason: string }> = [];
  for (const line of ndjson.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = JSON.parse(line) as ReplayEntry;
    const frame = entry.frame;
    if (frame === undefined) continue;
    if (
      entry.type === "expect_outbound" &&
      frame.kind === "request" &&
      frame.method === "session/prompt"
    ) {
      turns.push({ frames: [], stopReason: "end_turn" });
      continue;
    }
    const turn = turns.at(-1);
    if (entry.type !== "emit_inbound" || turn === undefined) continue;
    if (frame.kind === "response" && frame.method === "session/prompt") {
      const stopReason = (frame.result as { stopReason?: unknown } | undefined)?.stopReason;
      if (typeof stopReason === "string") turn.stopReason = stopReason;
      continue;
    }
    if (isReplayedFrame(frame)) {
      turn.frames.push(entry.afterMs === undefined ? { frame } : { frame, afterMs: entry.afterMs });
    }
  }
  return turns;
}

/** Splits streamed text into small chunks so the client sees real deltas. */
export function streamChunks(text: string): ReadonlyArray<string> {
  const words = text.match(/\S+\s*|\s+/g) ?? [];
  const chunks: Array<string> = [];
  for (let index = 0; index < words.length; index += WORDS_PER_CHUNK) {
    chunks.push(words.slice(index, index + WORDS_PER_CHUNK).join(""));
  }
  return chunks.length === 0 ? [text] : chunks;
}

function materialize(value: unknown, sessionId: string, workspace: string): unknown {
  if (typeof value === "string") return value.replaceAll("<workspace>", workspace);
  if (Array.isArray(value)) return value.map((entry) => materialize(entry, sessionId, workspace));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "sessionId" ? sessionId : materialize(entry, sessionId, workspace),
    ]),
  );
}

function runAgent(): void {
  const turnsByScenario = new Map<string, ReadonlyArray<ReplayTurn>>();
  const loadTurns = (scenarioId: string) => {
    const cached = turnsByScenario.get(scenarioId);
    if (cached !== undefined) return cached;
    const scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId) ?? SCENARIOS[0];
    const turns = parseReplayTurns(
      NodeFS.readFileSync(new URL(scenario.file, import.meta.url), "utf8"),
    );
    turnsByScenario.set(scenarioId, turns);
    return turns;
  };

  const sessions = new Map<
    string,
    { cwd: string; model: string; promptCount: number; cancel: (() => void) | undefined }
  >();
  const pendingAgentRequests = new Map<string, (result: unknown) => void>();
  let nextAgentRequestId = 1;
  let nextSessionNumber = 1;

  const send = (message: JsonRpcMessage) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    });

  const playTurn = async (sessionId: string, turn: ReplayTurn, signal: AbortSignal) => {
    const session = sessions.get(sessionId)!;
    for (const recorded of turn.frames) {
      if (signal.aborted) return;
      await sleep(Math.min(recorded.afterMs ?? FRAME_DELAY_MS, MAX_RECORDED_DELAY_MS), signal);
      const frame = materialize(recorded.frame, sessionId, session.cwd) as LogicalFrame;
      if (frame.kind === "request") {
        const id = nextAgentRequestId++;
        const response = new Promise<unknown>((resolve) =>
          pendingAgentRequests.set(String(id), resolve),
        );
        send({ id, method: frame.method, params: frame.params as Record<string, unknown> });
        await Promise.race([
          response,
          new Promise((resolve) => signal.addEventListener("abort", resolve)),
        ]);
        continue;
      }
      const params = frame.params as { update: { sessionUpdate: string; content?: unknown } };
      const content = params.update.content as { type?: string; text?: string } | undefined;
      const isStreamedText =
        (params.update.sessionUpdate === "agent_message_chunk" ||
          params.update.sessionUpdate === "agent_thought_chunk") &&
        content?.type === "text" &&
        typeof content.text === "string";
      if (!isStreamedText) {
        send({ method: frame.method, params });
        continue;
      }
      for (const [index, text] of streamChunks(content.text!).entries()) {
        if (signal.aborted) return;
        if (index > 0) await sleep(CHUNK_DELAY_MS, signal);
        send({
          method: frame.method,
          params: { ...params, update: { ...params.update, content: { ...content, text } } },
        });
      }
    }
  };

  const handleRequest = async (message: JsonRpcMessage): Promise<unknown> => {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
          },
          authMethods: [],
          agentInfo: { name: "t3-dev-replay", version: "1" },
        };
      case "session/new": {
        const sessionId = `dev-replay-session-${nextSessionNumber++}`;
        const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
        sessions.set(sessionId, { cwd, model: SCENARIOS[0].id, promptCount: 0, cancel: undefined });
        return {
          sessionId,
          models: {
            currentModelId: SCENARIOS[0].id,
            availableModels: SCENARIOS.map((scenario) => ({
              modelId: scenario.id,
              name: scenario.name,
            })),
          },
        };
      }
      case "session/set_model": {
        const session = sessions.get(String(params.sessionId));
        if (session !== undefined && typeof params.modelId === "string") {
          session.model = params.modelId;
        }
        return {};
      }
      case "session/prompt": {
        const sessionId = String(params.sessionId);
        const session = sessions.get(sessionId);
        if (session === undefined) throw new Error(`Unknown session ${sessionId}`);
        const turns = loadTurns(session.model);
        const turn = turns[session.promptCount % Math.max(turns.length, 1)];
        session.promptCount += 1;
        const controller = new AbortController();
        session.cancel = () => controller.abort();
        if (turn !== undefined) await playTurn(sessionId, turn, controller.signal);
        session.cancel = undefined;
        return {
          stopReason: controller.signal.aborted ? "cancelled" : (turn?.stopReason ?? "end_turn"),
        };
      }
      case "authenticate":
      case "session/set_mode":
      case "session/close":
        return {};
      default:
        throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
    }
  };

  const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (line.trim().length === 0) return;
    const message = JSON.parse(line) as JsonRpcMessage;
    if (message.method === undefined) {
      const resolve = pendingAgentRequests.get(String(message.id));
      pendingAgentRequests.delete(String(message.id));
      resolve?.(message.result);
      return;
    }
    if (message.id === undefined || message.id === null) {
      if (message.method === "session/cancel") {
        sessions.get(String(message.params?.sessionId))?.cancel?.();
      }
      return;
    }
    const id = message.id;
    handleRequest(message).then(
      (result) => send({ id, result }),
      (error: Error & { code?: number }) =>
        send({ id, error: { code: error.code ?? -32603, message: error.message } }),
    );
  });
}

if (import.meta.main) runAgent();
