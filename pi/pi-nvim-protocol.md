# Pi–Neovim JSONL Protocol

## Transport and framing

The Neovim plugin owns and listens on a Unix-domain socket and supplies its path to Pi as
`PI_NVIM_SOCKET`. The Pi extension connects to that path. Messages are UTF-8 JSON objects, one per
line, terminated by `\n`. A JSON object may span socket chunks; a chunk may contain multiple
messages. There is no protocol message-size limit.

Either peer may send a request. Every request has a non-empty string or numeric `id` and a `type`;
the receiver returns one correlated response after the operation succeeds or fails. Responses echo
the request ID and have either `ok: true` with a `result`, or `ok: false` with an `error`. Each
peer tracks its own outstanding request IDs. Incoming requests are processed in stream order per
connection; responses resolve the matching outstanding request and are not dispatched as requests.
Unmatched responses are ignored. There are no unsolicited messages and no version handshake.

## Requests and responses

### Submit a prompt

```json
{
    "id": "req-1",
    "type": "submit_prompt",
    "prompt": "Explain this function"
}
```

`prompt` is the complete user prompt. The extension starts a turn immediately when Pi is idle. If Pi
is busy, it queues the prompt as a follow-up.

### Submit a visual selection with a prompt

```json
{
    "id": "req-3",
    "type": "submit_selection_prompt",
    "text": "selected text",
    "prompt": "Explain this",
    "selection": {
        "buffer_id": 7,
        "path": "src/main.lua",
        "buffer_name": "main.lua",
        "start_line": 3,
        "start_col": 1,
        "end_line": 4,
        "end_col": 9,
        "selection_type": "line"
    }
}
```

Pi combines the source hint, selected text, and prompt into one user message and submits it
immediately. If Pi is busy, the message is queued as a follow-up. This request does not modify the
input editor.

### List open buffers

```json
{
    "id": "pi-1",
    "type": "list_buffers"
}
```

Pi sends this request to Neovim. The successful result is an array containing only listed buffers;
each item includes `buffer_id` (the Neovim buffer number) and `path`.

```json
{
    "id": "pi-1",
    "ok": true,
    "result": [{ "buffer_id": 7, "path": "src/main.lua" }]
}
```

### Open a file

```json
{
    "id": "pi-2",
    "type": "open_file",
    "path": "src/main.lua",
    "cursor_line": 42
}
```

Pi sends this request to Neovim. `path` is required and non-empty. `selection` is optional; when supplied, its
1-based start/end line and column coordinates and `selection_type` (`character`, `line`, or `block`)
follow the Visual-selection conventions. `cursor_line` is an optional positive, 1-based line number;
when supplied, Neovim places the cursor on that line without creating a Visual selection. Do not
combine `selection` and `cursor_line`. Omit both to open without positioning. A successful open
returns an empty object.

### Insert a visual selection

```json
{
    "id": "req-2",
    "type": "insert_selection",
    "text": "selected text",
    "selection": {
        "buffer_id": 7,
        "path": "src/main.lua",
        "buffer_name": "main.lua",
        "start_line": 3,
        "start_col": 1,
        "end_line": 4,
        "end_col": 9,
        "selection_type": "line"
    }
}
```

The extension inserts a source hint followed by `text` at the current Pi input-editor cursor
position, preserving existing editor content. The hint identifies a file buffer by path or a virtual
buffer by name, and includes the 1-based line/column range and selection type. This request does not
submit the editor contents. `selection` contains the source buffer identity (`buffer_id`), path
(null for virtual buffers), buffer name, 1-based start/end line and column, and selection type
(`character`, `line`, or `block`). Block selections require no additional corner semantics.

### Success

```json
{
    "id": "req-1",
    "ok": true,
    "result": {}
}
```

### Failure

```json
{
    "id": "req-2",
    "ok": false,
    "error": "Pi input editor is unavailable"
}
```

The receiver reports validation and operation failures this way. For malformed JSON, it sends a
failure when it can recover a valid ID from the input line. It closes neither process nor connection
merely because a request fails. A request without a recoverable ID cannot receive a correlated
response. A response with an unknown ID is ignored.

## Operation completion

A success response means the requested operation completed: prompt submission was accepted by Pi
(including queueing a follow-up), selection text was pasted into the editor, listed buffers were
returned, or the requested file was opened. A failure response communicates that the requested
operation could not be completed. Each receiver serializes responses to incoming requests in their
request order; independently initiated requests are correlated by ID and may complete asynchronously.
