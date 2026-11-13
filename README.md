# pi-nvim

[![Pi and Neovim](assets/pi-nvim.png)](assets/pi-nvim.png)

A Neovim plugin and Pi extension that connect Neovim to an interactive Pi session. The plugin provides the `:Pi` command and communicates with the extension over a local Unix-domain socket.

Project: [vladimir-popov](https://github.com/vladimir-popov)

## Requirements

- Neovim with Lua support and Unix-domain socket support.
- [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) installed and available as `pi` on `PATH`, unless configured with a different command.
- The Pi extension is loaded by the plugin from this repository; no separate extension installation is needed.

## Installation

Check out this repository and add its local path to your Neovim plugin manager. For example, with lazy.nvim:

```lua
{
  dir = "/path/to/pi-nvim",
  config = function()
    require("pi").setup()
  end,
}
```

Replace `"/path/to/pi-nvim"` with the directory where you checked out the project.

## Configuration

Call `require("pi").setup()` from your Neovim configuration. All options are optional:

```lua
require("pi").setup({
  command = "pi",
  placement = "tab",
  width = 80,
  height = 80,
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
| `width`              | `80`    | Width percentage for vertical splits and floating windows.                   |
| `height`             | `80`    | Height percentage for horizontal splits and floating windows.                |
| `connection_timeout` | `5000`  | Milliseconds to wait for the Pi extension to connect.                        |

Provider and model settings apply only when starting Pi. If either is also included in `command`, the plugin omits that duplicate option when the corresponding setting is configured. Split dimensions are percentages of the window from which Pi is opened; floating-window dimensions are percentages of the editor.

## Usage

- Run `:Pi` to start Pi in an embedded terminal, or to focus the existing plugin-managed session.
- Run `:Pi` while focused on the Pi terminal to return to the window and location active before entering Pi.
- Run `:Pi explain this code` to submit the complete argument as a prompt immediately.
- Select text in Visual mode and run `:Pi` to insert that selection at the current cursor position in Pi's input editor without submitting it. The existing editor text is preserved.

The plugin manages one Pi session per Neovim instance and does not attach to Pi terminals started independently. Pi starts in Neovim's current working directory. If the extension cannot connect before the configured timeout, the plugin reports the problem and cleans up the failed startup resources.

See [the JSONL protocol documentation](pi/pi-nvim-protocol.md) for the Neovim–Pi message format.

## Automated tests

Run the automated test suites with `make test`. The Node.js test suite requires Node.js 22.6.0 or newer; the Neovim integration tests run headlessly with a fake Pi executable and do not require API credentials.
