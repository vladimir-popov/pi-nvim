import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { connectProtocolSocket } from "./protocol.ts";

type SelectionType = "character" | "line" | "block";

type SourceInterval = {
    start_line: number;
    start_col: number;
    end_line: number;
    end_col: number;
    selection_type: SelectionType;
};

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

type ToolResult = {
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
};

type ToolDefinition = {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    parameters: TSchema;
    execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
};

interface PiApi {
    sendUserMessage(prompt: string, options?: { deliverAs: "followUp" }): Promise<unknown>;
    registerTool(tool: ToolDefinition): void;
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
 * Registers model-callable Neovim tools and session hooks for `PI_NVIM_SOCKET`.
 * The socket opens at session start and closes at shutdown; without the environment
 * variable, the tools remain registered but report that Neovim is unavailable.
 */
export default function piNvimExtension(pi: PiApi): void {
    let connection: Awaited<ReturnType<typeof connectProtocolSocket>> | undefined;
    let connectionError: unknown;
    let context: PiContext | undefined;
    const socketPath = process.env.PI_NVIM_SOCKET;

    const request = async (
        payload:
            | { type: "list_buffers" }
            | { type: "open_file"; path: string; selection?: SourceInterval },
    ) => {
        if (!connection) {
            const reason = connectionError instanceof Error ? `: ${connectionError.message}` : "";
            throw new Error(`Neovim connection is unavailable${reason}`);
        }
        return connection.request(payload);
    };
    const resultFor = (value: unknown): ToolResult => ({
        content: [{ type: "text", text: JSON.stringify(value) ?? "null" }],
        details: value,
    });

    pi.registerTool({
        name: "list_buffers",
        label: "List Neovim buffers",
        description: "List the currently listed Neovim buffers and their paths.",
        promptSnippet: "List open Neovim buffers",
        promptGuidelines: [
            "Use list_buffers to identify open files when session context refers to an existing buffer.",
        ],
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
            return resultFor(await request({ type: "list_buffers" }));
        },
    });

    pi.registerTool({
        name: "open_file",
        label: "Open file in Neovim",
        description: "Open a file in Neovim, optionally selecting a source interval.",
        promptSnippet: "Open a file in Neovim, optionally at a source interval",
        promptGuidelines: [
            "Use open_file when the user's file reference can be resolved from the conversation or listed buffers.",
            "Ask the user to clarify rather than guess when an open_file target is unclear or ambiguous, and offer likely paths when available.",
        ],
        parameters: Type.Object(
            {
                path: Type.String({ minLength: 1, description: "File path to open" }),
                selection: Type.Optional(
                    Type.Object(
                        {
                            start_line: Type.Integer({ minimum: 1 }),
                            start_col: Type.Integer({ minimum: 1 }),
                            end_line: Type.Integer({ minimum: 1 }),
                            end_col: Type.Integer({ minimum: 1 }),
                            selection_type: StringEnum(["character", "line", "block"] as const),
                        },
                        { additionalProperties: false },
                    ),
                ),
            },
            { additionalProperties: false },
        ),
        async execute(_toolCallId, params) {
            const path = params.path;
            if (typeof path !== "string" || path.length === 0) {
                throw new Error("path must be a non-empty string");
            }
            const selection = params.selection as SourceInterval | undefined;
            return resultFor(
                await request({ type: "open_file", path, ...(selection ? { selection } : {}) }),
            );
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        context = ctx;
        if (!socketPath) return;
        try {
            connection = await connectProtocolSocket({
                socketPath,
                handleRequest: createRequestHandler(pi, () => {
                    if (!context) throw new Error("Pi session context is unavailable");
                    return context;
                }),
            });
            connectionError = undefined;
        } catch (error) {
            connection = undefined;
            connectionError = error;
        }
    });

    pi.on("session_shutdown", async () => {
        const activeConnection = connection;
        connection = undefined;
        context = undefined;
        if (activeConnection) await activeConnection.close();
    });
}
