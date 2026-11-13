import net from "node:net";

function responseFor(id, result, error) {
  return error
    ? { id, ok: false, error: String(error.message ?? error) }
    : { id, ok: true, result };
}

/** Connects to Neovim's Unix socket, dispatches JSONL requests, and returns a close handle. */
export function connectProtocolSocket({ socketPath, handleRequest }) {
  const socket = net.createConnection(socketPath);
  let pending = "";
  let chain = Promise.resolve();

  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      chain = chain.then(() => processLine(line, socket, handleRequest));
    }
  });
  socket.on("end", () => {
    if (pending.trim()) chain = chain.then(() => processLine(pending, socket, handleRequest));
  });

  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      socket.on("error", () => {});
      resolve({ close: () => new Promise((done) => socket.end(done)) });
    });
  });
}

/** Parses and dispatches one request line, returning a correlated success or error response. */
async function processLine(line, socket, handleRequest) {
  let id;
  try {
    const request = JSON.parse(line);
    id = request?.id;
    if ((typeof id !== "string" && typeof id !== "number") || id === "") {
      throw new Error("Request id must be a non-empty string or number");
    }
    const result = await handleRequest(request);
    writeResponse(socket, responseFor(id, result));
  } catch (error) {
    const match = line.match(/"id"\s*:\s*("(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?)/);
    if (id === undefined && match) {
      try {
        id = JSON.parse(match[1]);
      } catch {}
    }
    if (id !== undefined) writeResponse(socket, responseFor(id, null, error));
  }
}

/** Writes one JSON response line if the socket is still open. */
function writeResponse(socket, response) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
}
