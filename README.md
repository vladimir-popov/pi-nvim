# pi-nvim

<p align="center">
  <img src="assets/pi-nvim.png" alt="Pi running in Neovim" height="300" />
</p>

**Keep Pi close while you code.** `pi-nvim` connects Neovim to
[Pi](https://pi.dev/) with a managed terminal and a lightweight companion
extension, just a simple bridge between your editor and your AI session. Send
selected text to Pi as context. One command to bring Pi into your workflow.

## Requirements

- Neovim 0.10 or newer.
- Pi installed and available as `pi` on `PATH`, or a custom Pi command configured below.
- The `pi-nvim` companion extension loaded by Pi. The extension uses Pi's interactive editor API.

## Installation and setup

### Install with Neovim's built-in package support

Clone the repository into Neovim's `start` package directory so it is loaded automatically:

```sh
mkdir -p ~/.local/share/nvim/site/pack/plugins/start
git clone https://github.com/vladimir-popov/pi-nvim \\
  ~/.local/share/nvim/site/pack/plugins/start/pi-nvim
```

If Neovim uses a custom data directory, put the repository under that directory's
`site/pack/plugins/start/` instead.

Add the setup call to your `init.lua`:

```lua
require("pi-nvim").setup()
```

### Install with lazy.nvim

Add this plugin specification to your lazy.nvim setup:

```lua
{
    "vladimir-popov/pi-nvim",
    keys = {
        { "<leader>pi", "<cmd>Pi<cr>", desc = "Open or focus Pi" },
        { "<leader>pi", "<C-\\><C-n><cmd>Pi<cr>", mode = "t", desc = "Return from Pi" },
        { "<leader>pi", ":<C-U>'<,'>Pi<CR>", mode = "x", desc = "Send selection to Pi" },
    }
}
```

## Configuration

### Configure the neovim plugin

All options are optional:

```lua
require("pi-nvim").setup({
  command = "pi",
  placement = "tab",
  width = 50,
  height = 50,
  -- provider = "anthropic",
  -- model = "claude-sonnet-4",
})
```

| Option               | Default | Description                                                                  |
| -------------------- | ------- | ---------------------------------------------------------------------------- |
| `command`            | `"pi"`  | Pi executable, or a non-empty argument list such as `{ "pi", "--verbose" }`. |
| `provider`           | unset   | Optional provider passed to Pi at startup. Requires `model`.                 |
| `model`              | unset   | Optional model passed to Pi at startup. May be set without `provider`.       |
| `placement`          | `"tab"` | Pi window placement: `"tab"`, `"horizontal"`, `"vertical"`, or `"float"`.    |
| `width`              | `50`    | Width percentage for vertical splits and floating windows.                   |
| `height`             | `50`    | Height percentage for horizontal splits and floating windows.                |
| `connection_timeout` | `5000`  | Milliseconds to wait for the Pi extension to connect.                        |

Provider and model settings apply only when starting Pi. If either is also included in `command`,
the plugin omits that duplicate option when the corresponding setting is configured. Split
dimensions are percentages of the window from which Pi is opened; floating-window dimensions are
percentages of the editor.


### Configure the Pi extension

To enable the companion extension, add its entry point to the `extensions` list in
`~/.pi/agent/settings.json`. Use the path where your plugin manager installed the repository. For
example, with the default install locations:

- Built-in package support: `~/.local/share/nvim/site/pack/plugins/start/pi-nvim/pi/pi-nvim.ts`
- lazy.nvim: `~/.local/share/nvim/lazy/pi-nvim/pi/pi-nvim.ts`

```json
{
  "extensions": [
    "~/.local/share/nvim/lazy/pi-nvim/pi/pi-nvim.ts"
  ]
}
```

Choose the path matching your installation and merge the entry into an existing `extensions` list
rather than replacing other configured extensions. If you customized Neovim's data directory or
lazy.nvim's install directory, use the corresponding path instead. Pi loads this project's extension
from `pi/pi-nvim.ts`.

## Usage

- Run `:Pi` to start Pi in an embedded terminal, or to focus the existing plugin-managed session.
- Run `:Pi` while focused on the Pi terminal to return to the window and location active before
  entering Pi.
- Run `:Pi <your prompt>` to submit the complete argument as a prompt immediately.
- Select text in Visual mode and run `:Pi` to insert that selection at the current cursor position
  in Pi's input editor without submitting it. The existing editor text is preserved.
- Select text in Visual mode and run `:Pi <your prompt>` to insert the selection followed by the
  prompt and a newline into Pi's input editor without submitting it.
- In Pi, run `/open` to choose a path mentioned in the latest assistant message and open it in
  Neovim. Ask Pi to list open buffers or open a file; it can select an optional source interval
  (line and column range, with character-, line-, or block-wise selection).

The plugin manages one Pi session per Neovim instance and does not attach to Pi terminals started
independently. Pi starts in Neovim's current working directory. The `list_buffers` tool reports
listed Neovim buffers; `open_file` opens a requested file and can select a source interval. If the
extension cannot connect before the configured timeout, the plugin reports the problem and cleans up
the failed startup resources.

See [the JSONL protocol documentation](pi/pi-nvim-protocol.md) for the Neovim–Pi message format.

## Automated tests

Run the automated test suites with `make test`. The Node.js test suite requires Node.js 22.6.0 or
newer; the Neovim integration tests run headlessly with a fake Pi executable and do not require API
credentials.
