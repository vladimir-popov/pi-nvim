import net from "node:net";

type RequestId = string | number;
type ProtocolResponse =
    { id: RequestId; ok: true; result: unknown } | { id: RequestId; ok: false; error: string };
type RequestHandler = (request: Record<string, unknown>) => unknown | Promise<unknown>;
type SocketCloseHandle = { close(): Promise<void> };

function responseFor(id: RequestId, result: unknown, error?: unknown): ProtocolResponse {
    return error
        ? { id, ok: false, error: String(error instanceof Error ? error.message : error) }
        : { id, ok: true, result };
}

/**
 * Connects to the Neovim Unix socket and dispatches newline-delimited JSON requests in order.
 * Resolves with a `close()` handle after connecting; rejects if the connection fails.
 * Each request is passed to `handleRequest`, with correlated success or error responses sent back.
 */
export function connectProtocolSocket({
    socketPath,
    handleRequest,
}: {
    socketPath: string;
    handleRequest: RequestHandler;
}): Promise<SocketCloseHandle> {
    const socket = net.createConnection(socketPath);
    let pending = "";
    let chain: Promise<void> = Promise.resolve();

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
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
        const onError = (error: Error) => reject(error);
        socket.once("error", onError);
        socket.once("connect", () => {
            socket.off("error", onError);
            socket.on("error", () => {});
            resolve({ close: () => new Promise<void>((done) => socket.end(done)) });
        });
    });
}

/** Parses and dispatches one request line, returning a correlated success or error response. */
async function processLine(
    line: string,
    socket: net.Socket,
    handleRequest: RequestHandler,
): Promise<void> {
    let id: RequestId | undefined;
    try {
        const request: unknown = JSON.parse(line);
        if (!isRecord(request)) throw new Error("Request must be a JSON object");
        id = request.id as RequestId | undefined;
        if ((typeof id !== "string" && typeof id !== "number") || id === "") {
            throw new Error("Request id must be a non-empty string or number");
        }
        const result = await handleRequest(request);
        writeResponse(socket, responseFor(id, result));
    } catch (error) {
        const match = line.match(/"id"\s*:\s*("(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?)/);
        if (id === undefined && match) {
            try {
                id = JSON.parse(match[1]) as RequestId;
            } catch {}
        }
        if (id !== undefined) writeResponse(socket, responseFor(id, null, error));
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Writes one JSON response line if the socket is still open. */
function writeResponse(socket: net.Socket, response: ProtocolResponse): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
}
