import { appendFileSync } from "node:fs";
import net from "node:net";

const mode = process.env.PI_NVIM_FAKE_MODE ?? "connect";
const eventFile = process.env.PI_NVIM_FAKE_LOG;
const socketPath = process.env.PI_NVIM_SOCKET;

function record(event: Record<string, unknown>) {
  if (eventFile) appendFileSync(eventFile, `${JSON.stringify(event)}\n`);
}

record({ type: "started", args: process.argv.slice(2), mode, socket: socketPath });

if (mode === "no-connect" || !socketPath) {
  // Keep the fake process alive just like an interactive Pi process that never connects.
  setInterval(() => {}, 60_000);
} else {
  const socket = net.createConnection(socketPath);
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => record({ type: "connected" }));
  socket.on("data", (chunk: string) => {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      record({ type: "request", request });
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
