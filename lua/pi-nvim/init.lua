local M = {}
local defaults = {
    command = "pi",
    provider = nil,
    model = nil,
    placement = "tab",
    width = 50,
    height = 50,
    connection_timeout = 5000,
}
local state = {
    config = nil,
    buf = nil,
    win = nil,
    job = nil,
    server = nil,
    client = nil,
    connected = false,
    prior = nil,
    next_id = 0,
}
local extension = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h:h")
    .. "/pi/pi-nvim.ts"

--- Shows a plugin-prefixed Neovim notification.
local function notify(message, level)
    vim.notify("pi-nvim: " .. message, level or vim.log.levels.INFO)
end

--- Validates merged plugin settings and raises an error for unsupported values.
local function valid_config(config)
    if config.provider and not config.model then
        error("provider requires model")
    end
    if type(config.command) ~= "string" and type(config.command) ~= "table" then
        error("command must be a string or argument list")
    end
    if
        type(config.command) == "table"
        and (#config.command == 0 or type(config.command[1]) ~= "string")
    then
        error("command argument list must not be empty")
    end
    if not vim.tbl_contains({ "tab", "horizontal", "vertical", "float" }, config.placement) then
        error("placement must be tab, horizontal, vertical, or float")
    end
    for _, key in ipairs({ "width", "height" }) do
        if type(config[key]) ~= "number" or config[key] <= 0 or config[key] > 100 then
            error(key .. " must be a percentage from 1 to 100")
        end
    end
end

--- Builds the Pi argument vector, adding configured model options and this plugin's extension.
local function argv()
    local c = state.config.command
    local args = type(c) == "table" and vim.deepcopy(c) or { c }
    local filtered = {}
    local skip_value = false
    for _, arg in ipairs(args) do
        if skip_value then
            skip_value = false
        elseif state.config.provider and arg == "--provider" then
            skip_value = true
        elseif state.config.model and arg == "--model" then
            skip_value = true
        elseif
            not (state.config.provider and arg:match("^%-%-provider="))
            and not (state.config.model and arg:match("^%-%-model="))
        then
            table.insert(filtered, arg)
        end
    end
    args = filtered
    if state.config.provider then
        vim.list_extend(args, { "--provider", state.config.provider })
    end
    if state.config.model then
        vim.list_extend(args, { "--model", state.config.model })
    end
    vim.list_extend(args, { "--extension", extension })
    return args
end

--- Fails queued requests that were waiting for the extension socket to connect.
local function fail_connect_waiters(message)
    local waiters = state.connect_waiters or {}
    state.connect_waiters = {}
    for _, waiter in ipairs(waiters) do
        waiter.callback(message)
    end
end

--- Fails and clears requests waiting for a response from Pi.
local function fail_pending_requests(message)
    for id, callback in pairs(state.pending or {}) do
        state.pending[id] = nil
        callback(message)
    end
end

--- Closes active socket handles, removes the socket file, and resets connection state.
local function close_socket()
    fail_pending_requests("Pi–Neovim socket closed")
    if state.client then
        state.client:close()
        state.client = nil
    end
    if state.server then
        state.server:close()
        state.server = nil
    end
    if state.socket_path then
        vim.fn.delete(state.socket_path)
        state.socket_path = nil
    end
    state.connected = false
end

--- Sends a request when connected, or queues it until the extension connects.
local function socket_request(payload, callback)
    if not state.client or not state.connected then
        state.connect_waiters = state.connect_waiters or {}
        table.insert(state.connect_waiters, { payload = payload, callback = callback })
        return
    end
    state.next_id = state.next_id + 1
    payload.id = tostring(state.next_id)
    state.pending = state.pending or {}
    state.pending[payload.id] = callback
    state.client:write(vim.json.encode(payload) .. "\n")
end

--- Creates the session socket and dispatches correlated responses to pending callbacks.
local function create_socket()
    local uv = vim.uv or vim.loop
    state.socket_path = vim.fn.tempname() .. ".sock"
    state.server = uv.new_pipe(false)
    assert(state.server:bind(state.socket_path))
    assert(state.server:listen(16, function(err)
        if err then
            notify("socket error: " .. err, vim.log.levels.ERROR)
            return
        end
        local client = uv.new_pipe(false)
        state.server:accept(client)
        state.client, state.connected = client, true
        local waiters = state.connect_waiters or {}
        state.connect_waiters = {}
        for _, waiter in ipairs(waiters) do
            socket_request(waiter.payload, waiter.callback)
        end
        local pending = ""
        client:read_start(function(read_err, chunk)
            if read_err then
                notify("socket read error: " .. read_err, vim.log.levels.ERROR)
            end
            if not chunk then
                state.connected = false
                fail_pending_requests(read_err or "Pi–Neovim socket closed")
                return
            end
            pending = pending .. chunk
            while true do
                local newline = pending:find("\n", 1, true)
                if not newline then
                    break
                end
                local line = pending:sub(1, newline - 1)
                pending = pending:sub(newline + 1)
                local ok, message = pcall(vim.json.decode, line)
                if
                    ok
                    and type(message) == "table"
                    and message.id ~= nil
                    and type(message.ok) == "boolean"
                then
                    local callback = state.pending and state.pending[message.id]
                    if callback then
                        state.pending[message.id] = nil
                        callback(message.ok and nil or message.error, message.result)
                    end
                elseif
                    ok
                    and type(message) == "table"
                    and message.id ~= nil
                    and type(message.type) == "string"
                then
                    client:write(vim.json.encode({
                        id = message.id,
                        ok = false,
                        error = "Unsupported request type: " .. message.type,
                    }) .. "\n")
                end
            end
        end)
    end))
end

--- Opens or focuses the managed Pi window and remembers the window being left.
local function enter_window()
    local current_win = vim.api.nvim_get_current_win()
    if not state.win or not vim.api.nvim_win_is_valid(state.win) or current_win ~= state.win then
        state.prior = {
            win = current_win,
            tab = vim.api.nvim_get_current_tabpage(),
            buf = vim.api.nvim_get_current_buf(),
        }
    end
    if state.win and vim.api.nvim_win_is_valid(state.win) then
        vim.api.nvim_set_current_win(state.win)
        vim.cmd("startinsert")
        return
    end
    local c = state.config
    if c.placement == "tab" then
        vim.cmd("tabnew")
    elseif c.placement == "horizontal" then
        local height =
            math.max(1, math.floor(vim.api.nvim_win_get_height(current_win) * c.height / 100))
        vim.cmd("belowright split")
        vim.api.nvim_win_set_height(vim.api.nvim_get_current_win(), height)
    elseif c.placement == "vertical" then
        local width =
            math.max(1, math.floor(vim.api.nvim_win_get_width(current_win) * c.width / 100))
        vim.cmd("belowright vsplit")
        vim.api.nvim_win_set_width(vim.api.nvim_get_current_win(), width)
    else
        local width = math.max(1, math.floor(vim.o.columns * c.width / 100))
        local height = math.max(1, math.floor(vim.o.lines * c.height / 100))
        vim.api.nvim_open_win(state.buf or vim.api.nvim_create_buf(false, true), true, {
            relative = "editor",
            row = math.floor((vim.o.lines - height) / 2),
            col = math.floor((vim.o.columns - width) / 2),
            width = width,
            height = height,
            style = "minimal",
            border = "single",
        })
    end
    state.win = vim.api.nvim_get_current_win()
    if state.buf and vim.api.nvim_buf_is_valid(state.buf) then
        vim.api.nvim_win_set_buf(state.win, state.buf)
    end
end

--- Starts Pi in the managed terminal unless its existing process is still running.
--- Sets up the extension socket and reports startup or connection failures to Neovim.
local function start()
    if state.job and state.job > 0 and vim.fn.jobwait({ state.job }, 0)[1] == -1 then
        enter_window()
        return
    end
    close_socket()
    create_socket()
    enter_window()
    state.buf = vim.api.nvim_get_current_buf()
    vim.api.nvim_buf_set_name(state.buf, "Pi")
    vim.bo[state.buf].bufhidden = "hide"
    local env = vim.fn.environ()
    env.PI_NVIM_SOCKET = state.socket_path
    state.job = vim.fn.jobstart(argv(), {
        term = true,
        cwd = vim.fn.getcwd(),
        env = env,
        on_exit = function()
            state.job = nil
            if not state.connected then
                local message = "Pi exited before its extension connected"
                notify(message, vim.log.levels.ERROR)
                fail_connect_waiters(message)
                close_socket()
            end
        end,
    })
    if state.job <= 0 then
        state.job = nil
        close_socket()
        notify("failed to start Pi", vim.log.levels.ERROR)
        return
    end
    vim.api.nvim_buf_set_option(state.buf, "buflisted", false)
    vim.defer_fn(function()
        if state.job and not state.connected then
            notify("Pi extension did not connect within five seconds", vim.log.levels.ERROR)
            fail_connect_waiters("Pi extension did not connect within five seconds")
            pcall(vim.fn.jobstop, state.job)
            state.job = nil
            close_socket()
        end
    end, state.config.connection_timeout)
    vim.cmd("startinsert")
end

--- Restores the previously active window and buffer when they are still valid.
local function return_prior()
    local prior = state.prior
    if prior and vim.api.nvim_win_is_valid(prior.win) then
        pcall(vim.api.nvim_set_current_win, prior.win)
        if vim.api.nvim_buf_is_valid(prior.buf) then
            pcall(vim.api.nvim_win_set_buf, prior.win, prior.buf)
        end
    else
        notify("previous window no longer exists", vim.log.levels.WARN)
    end
end

--- Ensures Pi is running and submits non-empty command arguments as a prompt.
local function send_command(args)
    if not state.job then
        start()
        if not state.job then
            return
        end
    else
        enter_window()
    end
    if args ~= "" then
        socket_request({ type = "submit_prompt", prompt = args }, function(err)
            if err then
                notify(err, vim.log.levels.ERROR)
            end
        end)
    end
end

--- Captures the current Visual selection and sends it to Pi with source metadata.
--- Starts the managed Pi session if needed; reports failure if it cannot be started.
local function transfer_selection()
    local buf = vim.api.nvim_get_current_buf()
    local start_pos, end_pos =
        vim.api.nvim_buf_get_mark(buf, "<"), vim.api.nvim_buf_get_mark(buf, ">")
    if start_pos[1] > end_pos[1] or (start_pos[1] == end_pos[1] and start_pos[2] > end_pos[2]) then
        start_pos, end_pos = end_pos, start_pos
    end
    local mode = vim.fn.visualmode()
    local selection_type = mode == "V" and "line" or (mode == "\22" and "block" or "character")
    local lines = vim.fn.getregion(vim.fn.getpos("'<"), vim.fn.getpos("'>"), {
        type = mode,
        exclusive = vim.o.selection == "exclusive",
    })
    local text = table.concat(lines, "\n")
    local name = vim.api.nvim_buf_get_name(buf)
    local meta = {
        buffer_id = buf,
        path = name ~= "" and name or vim.NIL,
        buffer_name = vim.fn.fnamemodify(name, ":t"),
        start_line = start_pos[1],
        start_col = start_pos[2] + 1,
        end_line = end_pos[1],
        end_col = end_pos[2] + 1,
        selection_type = selection_type,
    }
    if not state.job then
        start()
    else
        enter_window()
    end
    if not state.job then
        notify("failed to start Pi; selection was not transferred", vim.log.levels.ERROR)
        return
    end
    socket_request({ type = "insert_selection", text = text, selection = meta }, function(err)
        if err then
            notify(err, vim.log.levels.ERROR)
        end
    end)
end

--- Configures the plugin and registers the `:Pi` user command.
--- `options` overrides the defaults; invalid configuration raises an error.
--- See the plugin documentation for supported options and command behavior.
function M.setup(options)
    local config = vim.tbl_deep_extend("force", vim.deepcopy(defaults), options or {})
    valid_config(config)
    state.config = config
    vim.api.nvim_create_user_command("Pi", function(opts)
        if opts.range > 0 then
            transfer_selection()
        elseif opts.args ~= "" then
            send_command(opts.args)
        elseif state.job and vim.fn.jobwait({ state.job }, 0)[1] == -1 then
            if state.win == vim.api.nvim_get_current_win() then
                return_prior()
            else
                enter_window()
            end
        else
            start()
        end
    end, { nargs = "*", range = true, complete = "file" })
end

return M
