import net from "node:net";

type RequestId = string | number;
type ProtocolResponse =
    { id: RequestId; ok: true; result: unknown } | { id: RequestId; ok: false; error: string };
type RequestHandler = (request: Record<string, unknown>) => unknown | Promise<unknown>;
type SourceInterval = {
    start_line: number;
    start_col: number;
    end_line: number;
    end_col: number;
    selection_type: "character" | "line" | "block";
};
type OutboundRequest =
    | { type: "list_buffers" }
    | {
          type: "open_file";
          path: string;
          selection?: SourceInterval;
          cursor_line?: number;
      };
type SocketCloseHandle = {
    close(): Promise<void>;
    request(request: OutboundRequest): Promise<unknown>;
};

function responseFor(id: RequestId, result: unknown, error?: unknown): ProtocolResponse {
    return error
        ? { id, ok: false, error: String(error instanceof Error ? error.message : error) }
        : { id, ok: true, result };
}

/**
 * Connects to the Neovim Unix socket and dispatches newline-delimited JSON requests in order.
 * Resolves with a handle for closing the connection and sending correlated requests; rejects if
 * connection setup fails. Incoming requests are dispatched in order and receive correlated replies.
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
    let nextId = 0;
    let closed = false;
    const requests = new Map<
        RequestId,
        { resolve(value: unknown): void; reject(error: Error): void }
    >();

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (!line.trim()) continue;
            chain = chain.then(() => processLine(line, socket, handleRequest, requests));
        }
    });
    const onClosed = () => {
        if (closed) return;
        closed = true;
        failRequests(requests, new Error("Protocol socket closed"));
    };
    socket.on("end", () => {
        if (pending.trim()) {
            chain = chain.then(() => processLine(pending, socket, handleRequest, requests));
        }
        chain = chain.then(onClosed);
    });
    socket.on("close", () => {
        chain = chain.then(onClosed);
    });

    return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        socket.once("error", onError);
        socket.once("connect", () => {
            socket.off("error", onError);
            socket.on("error", (error) => {
                closed = true;
                failRequests(requests, error);
            });
            resolve({
                close: () => {
                    closed = true;
                    failRequests(requests, new Error("Protocol socket closed"));
                    return new Promise<void>((done) => socket.end(done));
                },
                request: (request) => {
                    try {
                        validateOutboundRequest(request);
                    } catch (error) {
                        return Promise.reject(error);
                    }
                    if (closed || socket.destroyed)
                        return Promise.reject(new Error("Protocol socket is closed"));
                    const id = `pi-${++nextId}`;
                    return new Promise((resolveRequest, rejectRequest) => {
                        requests.set(id, { resolve: resolveRequest, reject: rejectRequest });
                        socket.write(`${JSON.stringify({ ...request, id })}\n`, (error) => {
                            if (!error) return;
                            requests.delete(id);
                            rejectRequest(error);
                        });
                    });
                },
            });
        });
    });
}

/** Parses and dispatches one request line, returning a correlated success or error response. */
async function processLine(
    line: string,
    socket: net.Socket,
    handleRequest: RequestHandler,
    requests: Map<RequestId, { resolve(value: unknown): void; reject(error: Error): void }>,
): Promise<void> {
    let id: RequestId | undefined;
    try {
        const request: unknown = JSON.parse(line);
        if (!isRecord(request)) throw new Error("Request must be a JSON object");
        id = request.id as RequestId | undefined;
        if ((typeof id !== "string" && typeof id !== "number") || id === "") {
            throw new Error("Request id must be a non-empty string or number");
        }
        if (typeof request.ok === "boolean") {
            const pendingRequest = requests.get(id);
            if (!pendingRequest) return;
            requests.delete(id);
            if (request.ok) pendingRequest.resolve(request.result);
            else pendingRequest.reject(new Error(String(request.error ?? "Request failed")));
            return;
        }
        if (typeof request.type !== "string") throw new Error("Request type must be a string");
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

function validateOutboundRequest(request: OutboundRequest): void {
    if (request.type === "list_buffers") return;
    if (typeof request.path !== "string" || request.path.length === 0) {
        throw new Error("open_file path must be a non-empty string");
    }
    if (request.cursor_line !== undefined && request.selection !== undefined) {
        throw new Error("open_file cursor_line and selection cannot be combined");
    }
    if (request.cursor_line !== undefined) {
        if (!Number.isInteger(request.cursor_line) || request.cursor_line < 1) {
            throw new Error("open_file cursor_line must be a positive integer");
        }
    }
    if (request.selection === undefined) return;
    const selection = request.selection;
    for (const field of ["start_line", "start_col", "end_line", "end_col"] as const) {
        if (!Number.isInteger(selection[field]) || selection[field] < 1) {
            throw new Error(`selection.${field} must be a positive integer`);
        }
    }
    if (!["character", "line", "block"].includes(selection.selection_type)) {
        throw new Error("selection.selection_type must be character, line, or block");
    }
}

function failRequests(
    requests: Map<RequestId, { resolve(value: unknown): void; reject(error: Error): void }>,
    error: Error,
): void {
    for (const request of requests.values()) request.reject(error);
    requests.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Writes one JSON response line if the socket is still open. */
function writeResponse(socket: net.Socket, response: ProtocolResponse): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
}
