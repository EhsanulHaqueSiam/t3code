// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

import { parseReplayTurns, SCENARIOS, streamChunks } from "./dev-replay-agent.ts";

interface AgentMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: { readonly update?: { readonly toolCallId?: string } };
  readonly result?: { readonly sessionId?: string };
}

/** Runs the agent over stdio and returns every message it sent until each request is answered. */
async function talkToAgent(requests: ReadonlyArray<(sessionId: string) => object>) {
  const agent = NodeChildProcess.spawn(
    process.execPath,
    [NodeURL.fileURLToPath(new URL("./dev-replay-agent.ts", import.meta.url))],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const lines = NodeReadline.createInterface({ input: agent.stdout })[Symbol.asyncIterator]();
  const received: Array<AgentMessage> = [];
  let sessionId = "";
  try {
    for (const [index, request] of requests.entries()) {
      agent.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...request(sessionId) })}\n`,
      );
      for (;;) {
        const message = JSON.parse((await lines.next()).value as string) as AgentMessage;
        received.push(message);
        if (message.id !== index + 1 || message.method !== undefined) continue;
        sessionId = message.result?.sessionId ?? sessionId;
        break;
      }
    }
  } finally {
    agent.kill();
  }
  return { sessionId, received };
}

describe("dev replay agent", () => {
  it("gives each agent process its own session and each prompt its own tool ids", async () => {
    const prompt = (sessionId: string) => ({ method: "session/prompt", params: { sessionId } });
    const run = () =>
      talkToAgent([
        () => ({ method: "session/new", params: { cwd: "/tmp" } }),
        (sessionId) => ({
          method: "session/set_model",
          params: { sessionId, modelId: "todo-list" },
        }),
        prompt,
        prompt,
      ]);
    const [first, second] = await Promise.all([run(), run()]);
    expect(first.sessionId).not.toBe(second.sessionId);
    const toolCallIds = first.received.flatMap((message) =>
      message.params?.update?.toolCallId === undefined ? [] : [message.params.update.toolCallId],
    );
    expect(new Set(toolCallIds).size).toBe(4);
  });

  it.each(SCENARIOS)("$id plays a turn without session setup frames", ({ file }) => {
    const turns = parseReplayTurns(NodeFS.readFileSync(new URL(file, import.meta.url), "utf8"));
    expect(turns.length).toBeGreaterThan(0);
    const updates = turns.flatMap((turn) =>
      turn.frames.flatMap(({ frame }) =>
        frame.method === "session/update"
          ? [(frame.params as { update: { sessionUpdate: string } }).update.sessionUpdate]
          : [],
      ),
    );
    expect(updates).toContain("agent_message_chunk");
    expect(updates).not.toContain("available_commands_update");
  });

  it("keeps permission requests and the recorded stop reason in order", () => {
    const turns = parseReplayTurns(
      NodeFS.readFileSync(new URL(SCENARIOS[0].file, import.meta.url), "utf8"),
    );
    const methods = turns[0]!.frames.map(({ frame }) => frame.method);
    expect(methods).toContain("session/request_permission");
    expect(turns[0]!.stopReason).toBe("end_turn");
  });

  it("leaves frames after a prompt's response out of that turn", () => {
    const update = (text: string) => ({
      type: "emit_inbound",
      frame: {
        kind: "notification",
        method: "session/update",
        params: {
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      },
    });
    const transcript = [
      { type: "expect_outbound", frame: { kind: "request", method: "session/prompt" } },
      update("root"),
      { type: "emit_inbound", frame: { kind: "response", method: "session/prompt", result: {} } },
      update("background"),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const turns = parseReplayTurns(transcript);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.frames).toHaveLength(1);
  });

  it("streams text in chunks that rebuild the original", () => {
    const text = "One two three four five\n\n```ts\nx\n```";
    const chunks = streamChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });
});
