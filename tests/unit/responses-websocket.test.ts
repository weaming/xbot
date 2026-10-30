import { afterEach, describe, expect, test } from "bun:test";
import { createChatClient } from "../../src/tools/chat-orchestrator.js";

describe("Responses WebSocket", () => {
  const previous = process.env.OPENAI_RESPONSES_WEBSOCKET;
  afterEach(() => {
    if (previous === undefined) delete process.env.OPENAI_RESPONSES_WEBSOCKET;
    else process.env.OPENAI_RESPONSES_WEBSOCKET = previous;
  });

  test("转发请求并接收流式与非流式响应", async () => {
    process.env.OPENAI_RESPONSES_WEBSOCKET = " TrUe ";
    const requests: any[] = [];
    let connections = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (new URL(request.url).pathname !== "/v1/responses") return new Response("missing", { status: 404 });
        if (request.headers.get("authorization") !== "Bearer test-key") return new Response("unauthorized", { status: 401 });
        if (server.upgrade(request)) return;
        return new Response("upgrade required", { status: 400 });
      },
      websocket: {
        open() { connections += 1; },
        message(socket, message) {
          const request = JSON.parse(message.toString());
          if (request.generate === false) {
            socket.send(JSON.stringify({ type: "response.completed", response: { id: "warmup", output: [] } }));
            return;
          }
          requests.push(request);
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "OK" }));
          socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_test", output: [] } }));
        },
      },
    });
    try {
      const client = createChatClient("test-key", `http://127.0.0.1:${server.port}/v1`, "responses");
      const stream = await client.createResponse!({ model: "test", input: [], stream: true });
      const events = [];
      for await (const event of stream) events.push(event);
      expect(events.map(event => event.type)).toEqual(["response.output_text.delta", "response.completed"]);
      process.env.OPENAI_RESPONSES_WEBSOCKET = "1";
      const response = await client.createResponse!({ model: "test", input: [], stream: false });
      expect(response.id).toBe("resp_test");
      expect(requests).toHaveLength(2);
      expect(requests.every(request => request.type === "response.create" && !("stream" in request))).toBe(true);
      expect(connections).toBe(1);
      expect(requests[1].previous_response_id).toBe("resp_test");
      client.close?.();
    } finally {
      server.stop(true);
    }
  });

  test("复用连接，仅在前缀匹配时增量发送，并在响应不存在时恢复完整请求", async () => {
    process.env.OPENAI_RESPONSES_WEBSOCKET = "1";
    const requests: any[] = [];
    const firstInput = { role: "user", content: "查一下" };
    const output = { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}" };
    const toolResult = { type: "function_call_output", call_id: "call_1", output: "ok" };
    let connections = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("upgrade required", { status: 400 });
      },
      websocket: {
        open() { connections += 1; },
        message(socket, message) {
          const request = JSON.parse(message.toString());
          if (request.generate === false) {
            socket.send(JSON.stringify({ type: "response.completed", response: { id: "warmup", output: [] } }));
            return;
          }
          requests.push(request);
          if (requests.length === 2) {
            socket.send(JSON.stringify({ type: "error", code: "previous_response_not_found", message: "missing", param: null, sequence_number: 0 }));
            return;
          }
          const items = requests.length === 1 ? [output] : [];
          socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${requests.length}`, output: items } }));
        },
      },
    });
    const client = createChatClient("test-key", `http://127.0.0.1:${server.port}/v1`, "responses");
    try {
      await client.createResponse!({ model: "test", input: [firstInput], stream: false });
      await client.createResponse!({ model: "test", input: [firstInput, output, toolResult], stream: false });
      await client.createResponse!({ model: "other", input: [firstInput], stream: false });
      await client.createResponse!({ model: "other", input: [{ role: "user", content: "不同的历史" }], stream: false });
      expect(connections).toBe(1);
      expect(requests[1].previous_response_id).toBe("resp_1");
      expect(requests[1].input).toEqual([toolResult]);
      expect(requests[2].previous_response_id).toBeUndefined();
      expect(requests[2].input).toEqual([firstInput, output, toolResult]);
      expect(requests[3].previous_response_id).toBeUndefined();
      expect(requests[3].input).toEqual([firstInput]);
      expect(requests[4].previous_response_id).toBeUndefined();
      expect(requests[4].input).toEqual([{ role: "user", content: "不同的历史" }]);
    } finally {
      client.close?.();
      server.stop(true);
    }
  });

  test("升级失败时回退 HTTP Responses", async () => {
    process.env.OPENAI_RESPONSES_WEBSOCKET = "true";
    const methods: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        methods.push(request.method);
        if (request.method === "GET") return new Response("unsupported", { status: 426 });
        const body = await request.json() as { stream?: boolean };
        if (!body.stream) return Response.json({ id: "resp_http", output: [] });
        return new Response('data: {"type":"response.completed","response":{"id":"resp_http","output":[]}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const client = createChatClient("test-key", `http://127.0.0.1:${server.port}/v1`, "responses");
    try {
      const response = await client.createResponse!({ model: "test", input: [], stream: false });
      expect(response.id).toBe("resp_http");
      const next = await client.createResponse!({ model: "test", input: [], stream: false });
      expect(next.id).toBe("resp_http");
      expect(methods).toEqual(["GET", "POST", "POST"]);
    } finally {
      client.close?.();
      server.stop(true);
    }
  });

  test("同一会话跨回合复用连接，认证变化时重新连接", async () => {
    process.env.OPENAI_RESPONSES_WEBSOCKET = "true";
    const requests: any[] = [];
    let connections = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("upgrade required", { status: 400 });
      },
      websocket: {
        open() { connections += 1; },
        message(socket, message) {
          const request = JSON.parse(message.toString());
          if (request.generate === false) {
            socket.send(JSON.stringify({ type: "response.completed", response: { id: "warmup", output: [] } }));
            return;
          }
          requests.push(request);
          socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${requests.length}`, output: [] } }));
        },
      },
    });
    const sessionId = crypto.randomUUID();
    const url = `http://127.0.0.1:${server.port}/v1`;
    try {
      const first = createChatClient("key-1", url, "responses", sessionId);
      await first.createResponse!({ model: "test", input: [], stream: false });
      first.close?.();
      const second = createChatClient("key-1", url, "responses", sessionId);
      await second.createResponse!({ model: "test", input: [{ role: "user", content: "next" }], stream: false });
      second.close?.();
      const third = createChatClient("key-2", url, "responses", sessionId);
      await third.createResponse!({ model: "test", input: [], stream: false });
      third.close?.();
      expect(connections).toBe(2);
      expect(requests[1].previous_response_id).toBe("resp_1");
      expect(requests[1].input).toEqual([{ role: "user", content: "next" }]);
      expect(requests[2].previous_response_id).toBe("warmup");
    } finally {
      server.stop(true);
    }
  });

  test("取消等待中的请求会返回 AbortError", async () => {
    process.env.OPENAI_RESPONSES_WEBSOCKET = "true";
    const controller = new AbortController();
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("upgrade required", { status: 400 });
      },
      websocket: { message() { controller.abort(); } },
    });
    const client = createChatClient("test-key", `http://127.0.0.1:${server.port}/v1`, "responses");
    try {
      await expect(client.createResponse!({ model: "test", input: [], stream: false }, { signal: controller.signal }))
        .rejects.toMatchObject({ name: "AbortError" });
    } finally {
      client.close?.();
      server.stop(true);
    }
  });
});
