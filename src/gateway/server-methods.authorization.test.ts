import { describe, expect, it } from "vitest";
import { ErrorCodes, type ErrorShape } from "./protocol/index.js";
import { handleGatewayRequest } from "./server-methods.js";

type AuthResult = {
  ok: boolean | null;
  error?: ErrorShape;
  called: boolean;
};

async function runMethod(method: string, role: "node" | "operator", scopes: string[] = []) {
  let called = false;
  let ok: boolean | null = null;
  let error: ErrorShape | undefined;

  await handleGatewayRequest({
    req: {
      type: "req",
      id: "test-1",
      method,
      params: {},
    } as never,
    client: {
      connect: {
        role,
        scopes,
      },
    } as never,
    isWebchatConnect: () => false,
    respond: (nextOK, _payload, nextError) => {
      ok = nextOK;
      error = nextError;
    },
    context: {} as never,
    extraHandlers: {
      [method]: async () => {
        called = true;
      },
    },
  });

  return {
    ok,
    error,
    called,
  } satisfies AuthResult;
}

describe("gateway method authorization", () => {
  it("allows node role to use chat/session methods needed by mobile chat UI", async () => {
    const chatHistory = await runMethod("chat.history", "node");
    expect(chatHistory.called).toBe(true);
    expect(chatHistory.ok).toBe(null);

    const chatSend = await runMethod("chat.send", "node");
    expect(chatSend.called).toBe(true);
    expect(chatSend.ok).toBe(null);

    const sessionsList = await runMethod("sessions.list", "node");
    expect(sessionsList.called).toBe(true);
    expect(sessionsList.ok).toBe(null);
  });

  it("still blocks non-allowed methods for node role", async () => {
    const result = await runMethod("status", "node");
    expect(result.called).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(result.error?.message).toContain("unauthorized role: node");
  });

  it("keeps node-only methods restricted from operator role", async () => {
    const result = await runMethod("node.event", "operator", ["operator.admin"]);
    expect(result.called).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(result.error?.message).toContain("unauthorized role: operator");
  });
});
