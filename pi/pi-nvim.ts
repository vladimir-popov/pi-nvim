import { connectProtocolSocket } from "./protocol.ts";

type SelectionType = "character" | "line" | "block";

type Selection = {
    buffer_id: string | number;
    path: string | null;
    buffer_name: string;
    start_line: number;
    start_col: number;
    end_line: number;
    end_col: number;
    selection_type: SelectionType;
};

interface PiContext {
    isIdle(): boolean;
    ui: {
        getEditorText(): string | undefined;
        pasteToEditor(text: string): void;
    };
}

interface PiApi {
    sendUserMessage(prompt: string, options?: { deliverAs: "followUp" }): Promise<unknown>;
    on(event: "session_start", handler: (event: unknown, context: PiContext) => unknown): void;
    on(event: "session_shutdown", handler: () => unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Creates a handler for Neovim requests using Pi's message and editor APIs.
 * `getContext` must return the current extension context when each request is handled.
 * Throws for malformed or unsupported requests and unavailable editor state.
 */
export function createRequestHandler(
    pi: Pick<PiApi, "sendUserMessage">,
    getContext: () => PiContext,
): (request: unknown) => Promise<Record<string, never>> {
    return async (request) => {
        if (!isRecord(request)) throw new Error("Request must be a JSON object");

        if (request.type === "submit_prompt") {
            if (typeof request.prompt !== "string") throw new Error("prompt must be a string");
            const context = getContext();
            if (context.isIdle()) await pi.sendUserMessage(request.prompt);
            else await pi.sendUserMessage(request.prompt, { deliverAs: "followUp" });
            return {};
        }

        if (request.type === "insert_selection") {
            if (typeof request.text !== "string") throw new Error("text must be a string");
            const rawSelection = request.selection;
            if (!isRecord(rawSelection)) throw new Error("selection metadata is required");

            if (
                typeof rawSelection.buffer_id !== "string" &&
                !Number.isInteger(rawSelection.buffer_id)
            ) {
                throw new Error("selection.buffer_id must be a string or integer");
            }
            if (rawSelection.path !== null && typeof rawSelection.path !== "string") {
                throw new Error("selection.path must be a string or null");
            }
            if (typeof rawSelection.buffer_name !== "string") {
                throw new Error("selection.buffer_name must be a string");
            }
            for (const field of ["start_line", "start_col", "end_line", "end_col"] as const) {
                if (!Number.isInteger(rawSelection[field]) || (rawSelection[field] as number) < 1) {
                    throw new Error(`selection.${field} must be a positive integer`);
                }
            }
            if (
                rawSelection.selection_type !== "character" &&
                rawSelection.selection_type !== "line" &&
                rawSelection.selection_type !== "block"
            ) {
                throw new Error("selection.selection_type must be character, line, or block");
            }
            const selection = rawSelection as Selection;
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
export default function piNvimExtension(pi: PiApi): void {
    let connection: Awaited<ReturnType<typeof connectProtocolSocket>> | undefined;
    let context: PiContext | undefined;
    const socketPath = process.env.PI_NVIM_SOCKET;

    pi.on("session_start", async (_event, ctx) => {
        context = ctx;
        if (!socketPath) return;
        connection = await connectProtocolSocket({
            socketPath,
            handleRequest: createRequestHandler(pi, () => {
                if (!context) throw new Error("Pi session context is unavailable");
                return context;
            }),
        });
    });

    pi.on("session_shutdown", async () => {
        const activeConnection = connection;
        connection = undefined;
        context = undefined;
        if (activeConnection) await activeConnection.close();
    });
}
