import { appendFileSync } from "node:fs";
import net from "node:net";

const mode = process.env.PI_NVIM_FAKE_MODE ?? "connect";
const eventFile = process.env.PI_NVIM_FAKE_LOG;
const socketPath = process.env.PI_NVIM_SOCKET;

function record(event: Record<string, unknown>) {
    if (eventFile) appendFileSync(eventFile, `${JSON.stringify(event)}\n`);
}

record({
    type: "started",
    args: process.argv.slice(2),
    mode,
    socket: socketPath,
});

if (mode === "no-connect" || !socketPath) {
    // Keep the fake process alive just like an interactive Pi process that never connects.
    setInterval(() => {}, 60_000);
} else {
    const socket = net.createConnection(socketPath);
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
        record({ type: "connected" });
        if (mode.startsWith("operations")) {
            const path = process.env.PI_NVIM_OPERATION_PATH;
            socket.write(`${JSON.stringify({ id: "list-1", type: "list_buffers" })}\n`);
            socket.write(
                `${JSON.stringify({
                    id: "open-invalid",
                    type: "open_file",
                    path: `${path}.invalid`,
                    selection: {
                        start_line: 0,
                        start_col: 1,
                        end_line: 1,
                        end_col: 1,
                        selection_type: "character",
                    },
                })}\n`,
            );
            socket.write(`${JSON.stringify({ id: "open-plain", type: "open_file", path })}\n`);
            socket.write(
                `${JSON.stringify({ id: "open-missing", type: "open_file", path: ".pi-nvim-missing-test" })}\n`,
            );
            for (const [id, selection_type] of [
                ["open-character", "character"],
                ["open-line", "line"],
                ["open-block", "block"],
            ]) {
                socket.write(
                    `${JSON.stringify({
                        id,
                        type: "open_file",
                        path,
                        selection: {
                            start_line: 2,
                            start_col: 2,
                            end_line: 2,
                            end_col: 4,
                            selection_type,
                        },
                    })}\n`,
                );
            }
        }
    });
    socket.on("data", (chunk: string) => {
        pending += chunk;
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (!line.trim()) continue;
            const request = JSON.parse(line);
            record({ type: "request", request });
            if (request.ok !== undefined) {
                record({ type: "response", response: request });
                continue;
            }
            socket.write(`${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`);
        }
    });
    socket.on("error", (error) => {
        record({ type: "socket_error", message: error.message });
        process.exitCode = 1;
    });
}

process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
