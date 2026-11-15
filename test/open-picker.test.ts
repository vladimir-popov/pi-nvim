import assert from "node:assert/strict";
import { test } from "node:test";
import { extractAssistantFileReferences, extractFileReferences } from "../pi/open-picker.ts";

test("extracts Markdown links, code and plain-text file paths with line suffixes", () => {
    assert.deepEqual(
        extractFileReferences(
            "See [source](src/main.ts:42), `lib/helper.lua:7`, and config.json.",
        ),
        [
            { path: "src/main.ts", cursorLine: 42 },
            { path: "lib/helper.lua", cursorLine: 7 },
            { path: "config.json" },
        ],
    );
});

test("does not treat file-like Markdown labels as paths", () => {
    assert.deepEqual(extractFileReferences("[src/old.ts](src/new.ts)"), [
        { path: "src/new.ts" },
    ]);
});

test("preserves first-seen order across plain text, code, and Markdown links", () => {
    assert.deepEqual(
        extractFileReferences("src/first.ts then `src/second.ts` then [third](src/third.ts)"),
        [
            { path: "src/first.ts" },
            { path: "src/second.ts" },
            { path: "src/third.ts" },
        ],
    );
});

test("ignores fragment-only and non-file Markdown targets", () => {
    assert.deepEqual(
        extractFileReferences(
            "[section](#heading) [search](?query) [web](//example.com/a.ts) " +
                "[mail](mailto:a@example.com) [script](javascript:alert(1))",
        ),
        [],
    );
});

test("strips fragments from Markdown file targets", () => {
    assert.deepEqual(extractFileReferences("[source](src/main.ts#overview)"), [
        { path: "src/main.ts" },
    ]);
});

test("accepts extensionless Markdown file targets", () => {
    assert.deepEqual(extractFileReferences("See [build instructions](Makefile)."), [
        { path: "Makefile" },
    ]);
});

test("recognizes dotfiles in prose and code spans", () => {
    assert.deepEqual(extractFileReferences("Open .gitignore or `.env:12`."), [
        { path: ".gitignore" },
        { path: ".env", cursorLine: 12 },
    ]);
});

test("handles paths with spaces in code and Markdown link destinations", () => {
    assert.deepEqual(
        extractFileReferences("Use [source](<src/my file.ts>) and `lib/my helper.lua`."),
        [{ path: "src/my file.ts" }, { path: "lib/my helper.lua" }],
    );
});

test("does not treat ordinary prose or slash-separated expressions as paths", () => {
    assert.deepEqual(
        extractFileReferences("Open this file. Dr. Smith agrees, e.g. here: and/or input/output."),
        [],
    );
});

test("ignores URLs and non-file references and keeps first occurrence", () => {
    assert.deepEqual(
        extractFileReferences(
            "https://example.com/a.ts, e.g. this and i.e. that; src/a.ts:9 then src/a.ts:20",
        ),
        [{ path: "src/a.ts", cursorLine: 9 }],
    );
});

test("only extracts text from assistant messages, not tool calls or results", () => {
    assert.deepEqual(
        extractAssistantFileReferences({
            role: "assistant",
            content: [
                { type: "text", text: "Open `src/a.ts`." },
                { type: "toolCall", name: "read", arguments: { path: "secret.ts" } },
            ],
        }),
        [{ path: "src/a.ts" }],
    );
    assert.deepEqual(
        extractAssistantFileReferences({ role: "toolResult", content: "src/ignored.ts" }),
        [],
    );
});
