import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { connectProtocolSocket } from "./protocol.js";
import { createRequestHandler } from "./extension.js";

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function connect(handler) {
  const socketPath = path.join(os.tmpdir(), `pi-nvim-${process.pid}-${Math.random()}.sock`);
  let peer;
  const listener = net.createServer((socket) => { peer = socket; });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(socketPath, resolve);
  });
  servers.push({ close: () => new Promise((resolve) => listener.close(resolve)) });
  const connected = connectProtocolSocket({ socketPath, handleRequest: handler });
  while (!peer) await new Promise((resolve) => setTimeout(resolve, 1));
  await connected;
  return peer;
}

function readLines(socket, count) {
  return new Promise((resolve, reject) => {
    let data = "";
    const lines = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
      let newline;
      while ((newline = data.indexOf("\n")) !== -1) {
        lines.push(JSON.parse(data.slice(0, newline)));
        data = data.slice(newline + 1);
        if (lines.length === count) resolve(lines);
      }
    });
    socket.once("error", reject);
  });
}

test("parses chunked JSONL and returns correlated responses in order", async () => {
  const socket = await connect(async (request) => ({ echoed: request.value }));
  const responses = readLines(socket, 2);
  socket.write('{"id":"a","type":"test",');
  socket.write('"value":1}\n{"id":"b","type":"test","value":2}\n');
  assert.deepEqual(await responses, [
    { id: "a", ok: true, result: { echoed: 1 } },
    { id: "b", ok: true, result: { echoed: 2 } },
  ]);
  socket.destroy();
});

test("returns a correlated error for malformed JSON when its id is recoverable", async () => {
  const socket = await connect(() => ({}));
  const responses = readLines(socket, 1);
  socket.write('{"id":"broken", nope}\n');
  const [response] = await responses;
  assert.equal(response.id, "broken");
  assert.equal(response.ok, false);
  assert.match(response.error, /JSON|token/i);
  socket.destroy();
});

test("submits prompt and queues follow-up while busy", async () => {
  const sent = [];
  const pi = { sendUserMessage: async (...args) => sent.push(args) };
  let idle = true;
  const handler = createRequestHandler(pi, () => ({ isIdle: () => idle }));
  await handler({ type: "submit_prompt", prompt: "first" });
  idle = false;
  await handler({ type: "submit_prompt", prompt: "next" });
  assert.deepEqual(sent, [["first"], ["next", { deliverAs: "followUp" }]]);
});

test("pastes selection without submitting and reports unavailable editor", async () => {
  const pasted = [];
  const context = { ui: { getEditorText: () => "draft", pasteToEditor: (text) => pasted.push(text) } };
  const pi = { sendUserMessage: () => assert.fail("selection must not submit") };
  const handler = createRequestHandler(pi, () => context);
  await handler({
    type: "insert_selection",
    text: "selected",
    selection: {
      buffer_id: 1, path: "source.lua", buffer_name: "source.lua",
      start_line: 1, start_col: 1, end_line: 1, end_col: 8, selection_type: "character",
    },
  });
  assert.deepEqual(pasted, ["selected"]);
  await assert.rejects(
    () => createRequestHandler(pi, () => ({ ui: { getEditorText: () => undefined } }))({
      type: "insert_selection",
      text: "x",
      selection: {
        buffer_id: 1, path: null, buffer_name: "source.lua",
        start_line: 1, start_col: 1, end_line: 1, end_col: 1, selection_type: "character",
      },
    }),
    /unavailable/,
  );
});

test("rejects unsupported request types", async () => {
  const handler = createRequestHandler({}, () => ({}));
  await assert.rejects(() => handler({ type: "unknown" }), /Unsupported request type/);
});
