/** A file path mentioned by the assistant and its optional 1-based cursor line. */
export type FileReference = { path: string; cursorLine?: number };

const FILE_EXTENSIONS = new Set([
    "c",
    "cc",
    "cpp",
    "cs",
    "css",
    "csv",
    "cjs",
    "cts",
    "go",
    "h",
    "hpp",
    "html",
    "java",
    "js",
    "json",
    "jsonc",
    "jsx",
    "lua",
    "md",
    "mjs",
    "mts",
    "php",
    "py",
    "rb",
    "rs",
    "scss",
    "sh",
    "sql",
    "svg",
    "toml",
    "ts",
    "tsx",
    "txt",
    "vue",
    "xml",
    "yaml",
    "yml",
    "zig",
]);

/** Extracts ordered, deduplicated file references and optional `:line` positions from text. */
export function extractFileReferences(text: string): FileReference[] {
    const candidates: Array<{
        value: string;
        position: number;
        isMarkdownTarget?: boolean;
    }> = [];
    const markdownLink = /\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)/g;
    for (const match of text.matchAll(markdownLink)) {
        const target = normalizeMarkdownTarget(match[1]);
        if (target) {
            candidates.push({ value: target, position: match.index, isMarkdownTarget: true });
        }
    }
    const extensions = [...FILE_EXTENSIONS].sort((a, b) => b.length - a.length).join("|");
    const plainPath = new RegExp(
        `(?<![\\w@.+-])\\.[\\w-]+(?::\\d+)?|(?<![\\w@.+-])(?:~\\/|\\.\\.?\\/)[\\w@.+/-]+(?::\\d+)?|(?<![\\w@.+-])\\/[\\w@.+-]+\\/[\\w@.+/-]+(?::\\d+)?|(?:[\\w@.+-]+\\/)*[\\w@.+-]+\\.(?:${extensions})(?![\\w-])(?::\\d+)?`,
        "g",
    );
    for (const match of text.matchAll(/`+([\s\S]*?)`+/g)) {
        const code = match[1].trim();
        if (/^(?:~\/|\.\.?\/|\/|[\w.-]+\/)[\w./ -]+\.[\w-]+(?::\d+)?$/.test(code)) {
            candidates.push({ value: code, position: match.index });
        } else {
            for (const pathMatch of code.matchAll(plainPath)) {
                candidates.push({
                    value: pathMatch[0],
                    position: match.index + (pathMatch.index ?? 0),
                });
            }
        }
    }

    const withoutUrls = text
        .replace(/\[[^\]]*\]\([^)]*\)/g, (match) => " ".repeat(match.length))
        .replace(/(?:https?|ftp):\/\/[^\s)]+/gi, (match) => " ".repeat(match.length))
        .replace(/`+[\s\S]*?`+/g, (match) => " ".repeat(match.length));
    for (const match of withoutUrls.matchAll(plainPath)) {
        candidates.push({ value: match[0], position: match.index });
    }

    candidates.sort((left, right) => left.position - right.position);
    const references: FileReference[] = [];
    const seen = new Set<string>();
    for (const { value, isMarkdownTarget } of candidates) {
        const candidate = value.trim().replace(/^[([{"'`]+|[)\]},.;!?"'`]+$/g, "");
        const lineMatch = candidate.match(/:(\d+)$/);
        const cursorLine = lineMatch ? Number(lineMatch[1]) : undefined;
        const filePath = lineMatch ? candidate.slice(0, -lineMatch[0].length) : candidate;
        if (!filePath || /^(?:https?|ftp):\/\//i.test(filePath)) continue;
        if (!hasFilePathSyntax(filePath) && !isMarkdownTarget) continue;
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        references.push({ path: filePath, ...(cursorLine ? { cursorLine } : {}) });
    }
    return references;
}

/** Extracts paths changed by edit/write tool calls after the latest user message. */
export function extractEditedFileReferences(branch: unknown[]): FileReference[] {
    let lastUserMessage = -1;
    for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (
            isRecord(entry) &&
            entry.type === "message" &&
            isRecord(entry.message) &&
            entry.message.role === "user"
        ) {
            lastUserMessage = index;
            break;
        }
    }

    const references: FileReference[] = [];
    const seen = new Set<string>();
    for (const entry of branch.slice(lastUserMessage + 1)) {
        if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
        const content = entry.message.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (!isRecord(block) || block.type !== "toolCall") continue;
            if (block.name !== "edit" && block.name !== "write") continue;
            if (!isRecord(block.arguments) || typeof block.arguments.path !== "string") continue;
            const path = block.arguments.path;
            if (!path || seen.has(path)) continue;
            seen.add(path);
            references.push({ path });
        }
    }
    return references;
}

/** Extracts file references only from textual blocks of an assistant message. */
export function extractAssistantFileReferences(message: unknown): FileReference[] {
    if (!isRecord(message) || message.role !== "assistant") return [];
    const content = message.content;
    const text =
        typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                    .filter(
                        (block) =>
                            isRecord(block) &&
                            block.type === "text" &&
                            typeof block.text === "string",
                    )
                    .map((block) => (block as { text: string }).text)
                    .join("\n")
              : "";
    return extractFileReferences(text);
}

function normalizeMarkdownTarget(target: string): string | undefined {
    const destination = target.replace(/^<|>$/g, "").trim();
    if (
        !destination ||
        destination.startsWith("#") ||
        destination.startsWith("?") ||
        destination.startsWith("//")
    ) {
        return undefined;
    }
    const localTarget = destination.split(/[?#]/, 1)[0];
    const targetPath = localTarget.replace(/:\d+$/, "");
    if (!targetPath || /^[a-z][a-z\d+.-]*:/i.test(targetPath)) return undefined;
    return localTarget;
}

function hasFilePathSyntax(filePath: string): boolean {
    if (/[\\/]/.test(filePath) || /^\.[\w-]+$/.test(filePath)) return true;
    const extension = filePath.match(/\.([A-Za-z0-9_-]+)$/)?.[1].toLowerCase();
    return extension !== undefined && FILE_EXTENSIONS.has(extension);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
