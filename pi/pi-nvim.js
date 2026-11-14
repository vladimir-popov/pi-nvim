import { connectProtocolSocket } from "./protocol.js";

/**
 * Creates a handler for Neovim requests using Pi's message and editor APIs.
 * `getContext` must return the current extension context when each request is handled.
 * Throws for malformed or unsupported requests and unavailable editor state.
 */
export function createRequestHandler(pi, getContext) {
    return async (request) => {
        if (!request || typeof request !== "object" || Array.isArray(request)) {
            throw new Error("Request must be a JSON object");
        }

        if (request.type === "submit_prompt") {
            if (typeof request.prompt !== "string") throw new Error("prompt must be a string");
            const context = getContext();
            if (context.isIdle()) await pi.sendUserMessage(request.prompt);
            else await pi.sendUserMessage(request.prompt, { deliverAs: "followUp" });
            return {};
        }

        if (request.type === "insert_selection") {
            if (typeof request.text !== "string") throw new Error("text must be a string");
            const selection = request.selection;
            if (!selection || typeof selection !== "object")
                throw new Error("selection metadata is required");
            if (!(
                typeof selection.buffer_id === "string" || Number.isInteger(selection.buffer_id)
            )) {
                throw new Error("selection.buffer_id must be a string or integer");
            }
            if (selection.path !== null && typeof selection.path !== "string")
                throw new Error("selection.path must be a string or null");
            if (typeof selection.buffer_name !== "string")
                throw new Error("selection.buffer_name must be a string");
            for (const field of ["start_line", "start_col", "end_line", "end_col"]) {
                if (!Number.isInteger(selection[field]) || selection[field] < 1) {
                    throw new Error(`selection.${field} must be a positive integer`);
                }
            }
            if (!["character", "line", "block"].includes(selection.selection_type)) {
                throw new Error("selection.selection_type must be character, line, or block");
            }
            const context = getContext();
            const editorText = context.ui.getEditorText();
            if (typeof editorText !== "string") throw new Error("Pi input editor is unavailable");
            const source =
                selection.path !== null
                    ? `file "${selection.path}"`
                    : `virtual buffer "${selection.buffer_name}"`;
            const kind = {
                character: "character-wise",
                line: "line-wise",
                block: "block-wise",
            }[selection.selection_type];
            const hint = `[Source: ${source}; lines ${selection.start_line}-${selection.end_line}, columns ${selection.start_col}-${selection.end_col}; ${kind} selection]`;
            context.ui.pasteToEditor(`${hint}\n${request.text}`);
            return {};
        }

        throw new Error(`Unsupported request type: ${String(request.type)}`);
    };
}

/**
 * Registers Pi session hooks that connect to the socket named by `PI_NVIM_SOCKET`.
 * The connection is opened at session start and closed at session shutdown;
 * if the environment variable is absent, no socket connection is attempted.
 */
export default function piNvimExtension(pi) {
    let connection;
    let context;
    const socketPath = process.env.PI_NVIM_SOCKET;

    pi.on("session_start", async (_event, ctx) => {
        context = ctx;
        if (!socketPath) return;
        connection = await connectProtocolSocket({
            socketPath,
            handleRequest: createRequestHandler(pi, () => context),
        });
    });

    pi.on("session_shutdown", async () => {
        const activeConnection = connection;
        connection = undefined;
        context = undefined;
        if (activeConnection) await activeConnection.close();
    });
}
