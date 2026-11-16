import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { connectProtocolSocket } from "../pi/protocol.ts";
import piNvimExtension, { createRequestHandler } from "../pi/pi-nvim.ts";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function connect(handler: (request: any) => unknown) {
    const socketPath = path.join(os.tmpdir(), `pi-nvim-${process.pid}-${Math.random()}.sock`);
    let peer: net.Socket | undefined;
    const listener = net.createServer((socket) => {
        peer = socket;
    });
    await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(socketPath, resolve);
    });
    servers.push({
        close: () =>
            new Promise((resolve) => {
                peer?.destroy();
                listener.close(() => resolve());
            }),
    });
    const connected = connectProtocolSocket({
        socketPath,
        handleRequest: handler,
    });
    while (!peer) await new Promise((resolve) => setTimeout(resolve, 1));
    const connection = await connected;
    Object.assign(peer, { protocol: connection });
    return peer;
}

function readLines(socket: net.Socket, count: number) {
    return new Promise<any[]>((resolve, reject) => {
        let data = "";
        const lines: any[] = [];
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

test("sends outbound requests and resolves their correlated responses", async () => {
    const socket = await connect(() => ({}));
    const responses = readLines(socket, 1);
    const result = socket.protocol.request({ type: "list_buffers" });
    const [request] = await responses;
    assert.equal(request.type, "list_buffers");
    assert.match(request.id, /^pi-\d+$/);
    socket.write(
        `${JSON.stringify({ id: request.id, ok: true, result: [{ buffer_id: 3, path: "src/a.ts" }] })}\n`,
    );
    assert.deepEqual(await result, [{ buffer_id: 3, path: "src/a.ts" }]);
    socket.destroy();
});

test("sends a cursor-line open request", async () => {
    const socket = await connect(() => ({}));
    const responses = readLines(socket, 1);
    const result = socket.protocol.request({
        type: "open_file",
        path: "src/a.ts",
        cursor_line: 42,
    });
    const [request] = await responses;
    assert.equal(request.type, "open_file");
    assert.equal(request.path, "src/a.ts");
    assert.equal(request.cursor_line, 42);
    socket.write(`${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`);
    assert.deepEqual(await result, {});
    socket.destroy();
});

test("rejects outbound requests on correlated errors and ignores unknown responses", async () => {
    const socket = await connect(() => assert.fail("responses are not requests"));
    const responses = readLines(socket, 1);
    const result = socket.protocol.request({
        type: "open_file",
        path: "src/a.ts",
        selection: {
            start_line: 2,
            start_col: 3,
            end_line: 4,
            end_col: 5,
            selection_type: "block",
        },
    });
    const [request] = await responses;
    assert.equal(request.path, "src/a.ts");
    assert.deepEqual(request.selection, {
        start_line: 2,
        start_col: 3,
        end_line: 4,
        end_col: 5,
        selection_type: "block",
    });
    socket.write(`${JSON.stringify({ id: "unmatched", ok: true, result: {} })}\n`);
    socket.write(`${JSON.stringify({ id: request.id, ok: false, error: "not found" })}\n`);
    await assert.rejects(result, /not found/);
    socket.destroy();
});

test("validates outbound file paths and source intervals", async () => {
    const socket = await connect(() => ({}));
    await assert.rejects(
        socket.protocol.request({ type: "open_file", path: "", selection: undefined }),
        /path must be a non-empty string/,
    );
    await assert.rejects(
        socket.protocol.request({ type: "open_file", path: "src/a.ts", cursor_line: 0 }),
        /cursor_line must be a positive integer/,
    );
    await assert.rejects(
        socket.protocol.request({
            type: "open_file",
            path: "src/a.ts",
            cursor_line: 1,
            selection: {
                start_line: 1,
                start_col: 1,
                end_line: 1,
                end_col: 1,
                selection_type: "character",
            },
        }),
        /cannot be combined/,
    );
    await assert.rejects(
        socket.protocol.request({
            type: "open_file",
            path: "src/a.ts",
            selection: {
                start_line: 0,
                start_col: 1,
                end_line: 1,
                end_col: 1,
                selection_type: "character",
            },
        }),
        /start_line must be a positive integer/,
    );
    socket.destroy();
});

test("processes a received response before failing other requests on graceful shutdown", async () => {
    const socket = await connect(() => ({}));
    const requests = readLines(socket, 1);
    const result = socket.protocol.request({ type: "list_buffers" });
    const [request] = await requests;
    socket.write(`${JSON.stringify({ id: request.id, ok: true, result: [] })}\n`);
    socket.end();
    assert.deepEqual(await result, []);
});

test("rejects pending outbound requests when the connection closes", async () => {
    const socket = await connect(() => ({}));
    const responses = readLines(socket, 1);
    const result = socket.protocol.request({ type: "open_file", path: "src/a.ts" });
    await responses;
    socket.destroy();
    await assert.rejects(result, /closed/i);
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
    const sent: unknown[][] = [];
    const pi = { sendUserMessage: async (...args: unknown[]) => sent.push(args) };
    let idle = true;
    const handler = createRequestHandler(pi, () => ({ isIdle: () => idle }));
    await handler({ type: "submit_prompt", prompt: "first" });
    idle = false;
    await handler({ type: "submit_prompt", prompt: "next" });
    assert.deepEqual(sent, [["first"], ["next", { deliverAs: "followUp" }]]);
});

test("submits selected text with a prompt immediately", async () => {
    const sent: unknown[][] = [];
    const pi = { sendUserMessage: async (...args: unknown[]) => sent.push(args) };
    const context = {
        isIdle: () => true,
        ui: { getEditorText: () => "", pasteToEditor: () => assert.fail("must not paste") },
    };
    const handler = createRequestHandler(pi, () => context);
    await handler({
        type: "submit_selection_prompt",
        text: "selected",
        prompt: "Explain this",
        selection: {
            buffer_id: 1,
            path: "source.lua",
            buffer_name: "source.lua",
            start_line: 1,
            start_col: 1,
            end_line: 1,
            end_col: 8,
            selection_type: "character",
        },
    });
    assert.deepEqual(sent, [[
        `[Source: file "source.lua"; lines 1-1, columns 1-8; character-wise selection]\nselected\n\nExplain this`,
    ]]);
});

test("pastes selection without submitting and reports unavailable editor", async () => {
    const pasted: string[] = [];
    const context = {
        ui: {
            getEditorText: () => "draft",
            pasteToEditor: (text: string) => pasted.push(text),
        },
    };
    const pi = {
        sendUserMessage: () => assert.fail("selection must not submit"),
    };
    const handler = createRequestHandler(pi, () => context);
    await handler({
        type: "insert_selection",
        text: "selected",
        selection: {
            buffer_id: 1,
            path: "source.lua",
            buffer_name: "source.lua",
            start_line: 1,
            start_col: 1,
            end_line: 1,
            end_col: 8,
            selection_type: "character",
        },
    });
    assert.deepEqual(pasted, [
        `[Source: file "source.lua"; lines 1-1, columns 1-8; character-wise selection]\nselected`,
    ]);
    await assert.rejects(
        () =>
            createRequestHandler(pi, () => ({
                ui: { getEditorText: () => undefined },
            }))({
                type: "insert_selection",
                text: "x",
                selection: {
                    buffer_id: 1,
                    path: null,
                    buffer_name: "source.lua",
                    start_line: 1,
                    start_col: 1,
                    end_line: 1,
                    end_col: 1,
                    selection_type: "character",
                },
            }),
        /unavailable/,
    );
});

test("registers Neovim tools and forwards their calls over the session socket", async () => {
    const socketPath = path.join(os.tmpdir(), `pi-nvim-tools-${process.pid}-${Math.random()}.sock`);
    const received: any[] = [];
    const listener = net.createServer((socket) => {
        let pending = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
            pending += chunk;
            let newline;
            while ((newline = pending.indexOf("\n")) !== -1) {
                const request = JSON.parse(pending.slice(0, newline));
                pending = pending.slice(newline + 1);
                received.push(request);
                if (request.path === "missing.ts") {
                    socket.write(
                        `${JSON.stringify({ id: request.id, ok: false, error: "not found" })}\n`,
                    );
                    continue;
                }
                const result =
                    request.type === "list_buffers" ? [{ buffer_id: 2, path: "src/a.ts" }] : {};
                socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(socketPath, resolve);
    });
    servers.push({ close: () => new Promise((resolve) => listener.close(() => resolve())) });

    const previousSocket = process.env.PI_NVIM_SOCKET;
    process.env.PI_NVIM_SOCKET = socketPath;
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const shortcuts = new Map<string, any>();
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
        registerTool: (tool: any) => tools.set(tool.name, tool),
        registerCommand: (name: string, command: any) => commands.set(name, command),
        registerShortcut: (shortcut: string, options: any) => shortcuts.set(shortcut, options),
        on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
        sendUserMessage: async (...args: unknown[]) => sent.push(args),
    };
    const sent: unknown[][] = [];
    try {
        piNvimExtension(pi as any);
        assert.deepEqual([...tools.keys()], ["list_buffers", "open_file"]);
        assert.ok(commands.has("open"));
        assert.ok(shortcuts.has("alt+o"));
        await shortcuts.get("alt+o").handler();
        assert.deepEqual(sent, [["/open", { expandPromptTemplates: true }]]);
        const listSchema = tools.get("list_buffers").parameters;
        const openSchema = tools.get("open_file").parameters;
        assert.equal(listSchema.type, "object");
        assert.deepEqual(listSchema.properties, {});
        assert.equal(openSchema.type, "object");
        assert.deepEqual(openSchema.required, ["path"]);
        assert.equal(openSchema.properties.path.minLength, 1);
        assert.equal(openSchema.properties.cursor_line.type, "integer");
        assert.equal(openSchema.properties.selection.properties.start_line.type, "integer");
        assert.deepEqual(openSchema.properties.selection.properties.selection_type.enum, [
            "character",
            "line",
            "block",
        ]);
        assert.match(tools.get("open_file").promptGuidelines.join(" "), /ambiguous/);
        assert.match(tools.get("open_file").promptGuidelines.join(" "), /show, or display/);
        assert.match(tools.get("open_file").promptGuidelines.join(" "), /Do not print the file contents/);
        await handlers.get("session_start")?.(
            {},
            {
                isIdle: () => true,
                ui: { getEditorText: () => "", pasteToEditor: () => {} },
            },
        );

        const buffers = await tools.get("list_buffers").execute("call-1", {});
        assert.deepEqual(buffers.details, [{ buffer_id: 2, path: "src/a.ts" }]);
        const opened = await tools.get("open_file").execute("call-2", {
            path: "src/a.ts",
            selection: {
                start_line: 1,
                start_col: 2,
                end_line: 3,
                end_col: 4,
                selection_type: "line",
            },
        });
        assert.deepEqual(opened.details, {});
        assert.deepEqual(
            received.map(({ id, ...request }) => request),
            [
                { type: "list_buffers" },
                {
                    type: "open_file",
                    path: "src/a.ts",
                    selection: {
                        start_line: 1,
                        start_col: 2,
                        end_line: 3,
                        end_col: 4,
                        selection_type: "line",
                    },
                },
            ],
        );
        const pickerNotices: Array<{ message: string; level: string }> = [];
        let choices: string[] = [];
        await commands.get("open").handler("", {
            sessionManager: {
                getBranch: () => [
                    { type: "message", message: { role: "assistant", content: "old.ts" } },
                    {
                        type: "message",
                        message: {
                            role: "assistant",
                            content: [
                                { type: "text", text: "See [latest](src/latest.ts:8) and other.ts." },
                                { type: "toolCall", arguments: { path: "secret.ts" } },
                            ],
                        },
                    },
                    { type: "message", message: { role: "toolResult", content: "hidden.ts" } },
                ],
            },
            ui: {
                select: async (_title: string, options: string[]) => {
                    choices = options;
                    return "src/latest.ts:8";
                },
                notify: (message: string, level: string) => pickerNotices.push({ message, level }),
            },
        });
        assert.deepEqual(choices, ["src/latest.ts:8", "other.ts"]);
        assert.deepEqual(
            received.at(-1),
            {
                id: received.at(-1).id,
                type: "open_file",
                path: "src/latest.ts",
                cursor_line: 8,
            },
        );
        const previousRequestCount = received.length;
        await commands.get("open").handler("", {
            sessionManager: {
                getBranch: () => [{ type: "message", message: { role: "assistant", content: "No paths." } }],
            },
            ui: {
                select: async () => assert.fail("empty picker must not open"),
                notify: (message: string, level: string) => pickerNotices.push({ message, level }),
            },
        });
        assert.equal(received.length, previousRequestCount);
        assert.equal(pickerNotices[0].level, "info");
        await commands.get("open").handler("", {
            sessionManager: {
                getBranch: () => [
                    { type: "message", message: { role: "assistant", content: "src/cancel.ts" } },
                ],
            },
            ui: {
                select: async () => undefined,
                notify: (message: string, level: string) => pickerNotices.push({ message, level }),
            },
        });
        assert.equal(received.length, previousRequestCount);
        await commands.get("open").handler("", {
            sessionManager: {
                getBranch: () => [{ type: "message", message: { role: "assistant", content: "missing.ts" } }],
            },
            ui: {
                select: async () => "missing.ts",
                notify: (message: string, level: string) => pickerNotices.push({ message, level }),
            },
        });
        assert.equal(pickerNotices.at(-1)?.level, "error");
        await assert.rejects(
            () => tools.get("open_file").execute("call-3", { path: "missing.ts" }),
            /not found/,
        );
        await handlers.get("session_shutdown")?.();
        await assert.rejects(() => tools.get("list_buffers").execute("call-4", {}), /unavailable/);
    } finally {
        if (previousSocket === undefined) delete process.env.PI_NVIM_SOCKET;
        else process.env.PI_NVIM_SOCKET = previousSocket;
        await handlers.get("session_shutdown")?.();
    }
});

test("allows startup when the Neovim socket is unavailable", async () => {
    const previousSocket = process.env.PI_NVIM_SOCKET;
    process.env.PI_NVIM_SOCKET = path.join(
        os.tmpdir(),
        `pi-nvim-unavailable-${process.pid}-${Math.random()}.sock`,
    );
    const tools = new Map<string, any>();
    const handlers = new Map<string, (...args: any[]) => unknown>();
    try {
        piNvimExtension({
            registerTool: (tool: any) => tools.set(tool.name, tool),
            registerCommand: () => {},
            registerShortcut: () => {},
            on: (event: string, handler: (...args: any[]) => unknown) =>
                handlers.set(event, handler),
            sendUserMessage: async () => {},
        } as any);
        await assert.doesNotReject(() =>
            handlers.get("session_start")?.(
                {},
                {
                    isIdle: () => true,
                    ui: { getEditorText: () => "", pasteToEditor: () => {} },
                },
            ),
        );
        await assert.rejects(() => tools.get("list_buffers").execute("call-1", {}), /unavailable/);
    } finally {
        if (previousSocket === undefined) delete process.env.PI_NVIM_SOCKET;
        else process.env.PI_NVIM_SOCKET = previousSocket;
        await handlers.get("session_shutdown")?.();
    }
});

test("rejects unsupported request types", async () => {
    const handler = createRequestHandler({}, () => ({}));
    await assert.rejects(() => handler({ type: "unknown" }), /Unsupported request type/);
});
