# Pi–Neovim JSONL Protocol

## Transport and framing

The Neovim plugin owns and listens on a Unix-domain socket and supplies its path to Pi as `PI_NVIM_SOCKET`. The Pi extension connects to that path. Messages are UTF-8 JSON objects, one per line, terminated by `\n`. A JSON object may span socket chunks; a chunk may contain multiple messages. There is no protocol message-size limit.

Every request has a non-empty string or numeric `id` and a `type`. The extension sends one response for each valid-ID request after the operation succeeds or fails. The response echoes the ID. Messages are processed in stream order on each connection. There are no unsolicited messages and no version handshake.

## Requests and responses

### Submit a prompt

```json
{ "id": "req-1", "type": "submit_prompt", "prompt": "Explain this function" }
```

`prompt` is the complete user prompt. The extension starts a turn immediately when Pi is idle. If Pi is busy, it queues the prompt as a follow-up.

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

The extension inserts a source hint followed by `text` at the current Pi input-editor cursor position, preserving existing editor content. The hint identifies a file buffer by path or a virtual buffer by name, and includes the 1-based line/column range and selection type. This request does not submit the editor contents. `selection` contains the source buffer identity (`buffer_id`), path (null for virtual buffers), buffer name, 1-based start/end line and column, and selection type (`character`, `line`, or `block`). Block selections require no additional corner semantics.

### Success

```json
{ "id": "req-1", "ok": true, "result": {} }
```

### Failure

```json
{ "id": "req-2", "ok": false, "error": "Pi input editor is unavailable" }
```

The extension reports validation, unsupported-type, editor-availability, insertion, and prompt-submission failures this way. For malformed JSON, it sends a failure when it can recover a valid ID from the input line. It closes neither the Pi process nor the connection merely because a request fails. A request without a recoverable ID cannot receive a correlated response.

## Operation completion

A success response means the extension API call completed successfully: prompt submission was accepted by Pi (including queueing a follow-up), or selection text was pasted into the editor. A failure response communicates that the requested operation could not be completed. Responses are serialized in request order per connection.
