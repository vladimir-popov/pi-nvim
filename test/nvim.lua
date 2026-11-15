local root = assert(vim.env.PI_NVIM_TEST_ROOT, "PI_NVIM_TEST_ROOT is required")
local mode = vim.env.PI_NVIM_FAKE_MODE or "connect"
vim.opt.runtimepath:append(root)
local log = vim.fn.tempname()
vim.env.PI_NVIM_FAKE_LOG = log

local function fail(message)
    io.stderr:write("Neovim integration test failed: " .. message .. "\n")
    vim.cmd("cquit 1")
end

local function events()
    if vim.fn.filereadable(log) == 0 then
        return {}
    end
    local lines = vim.fn.readfile(log)
    local result = {}
    for _, line in ipairs(lines) do
        local ok, value = pcall(vim.json.decode, line)
        if ok then
            table.insert(result, value)
        end
    end
    return result
end

local function wait_for(predicate, message, timeout)
    if not vim.wait(timeout or 3000, predicate, 10) then
        fail(message)
    end
end

local function find_event(kind, request_type)
    for _, event in ipairs(events()) do
        if
            event.type == kind
            and (not request_type or (event.request and event.request.type == request_type))
        then
            return event
        end
    end
end

local notices = {}
local original_notify = vim.notify
vim.notify = function(message, level)
    table.insert(notices, { message = message, level = level })
end

local operation_path = ".pi-nvim-open-test"
if mode:match("^operations") then
    vim.fn.writefile({ "first line", "second line", "third line" }, operation_path)
    vim.fn.writefile({ "invalid selection target" }, operation_path .. ".invalid")
    vim.env.PI_NVIM_OPERATION_PATH = operation_path
end

local placement = (mode == "horizontal" or mode == "vertical") and mode or "tab"
require("pi-nvim").setup({
    command = { vim.fn.exepath("node"), "--experimental-strip-types", root .. "/test/fake-pi.ts" },
    connection_timeout = mode == "no-connect" and 100 or 3000,
    placement = placement,
    width = 60,
    height = 60,
})

if mode == "no-connect" then
    vim.cmd("Pi")
    wait_for(function()
        return find_event("started") ~= nil
    end, "fake Pi did not start")
    local started = find_event("started")
    local socket_path = started.socket
    vim.wait(500, function()
        return false
    end, 10)
    if socket_path and vim.fn.getftype(socket_path) ~= "" then
        fail("socket was not removed after connection timeout")
    end
    local notified = false
    for _, notice in ipairs(notices) do
        if notice.level == vim.log.levels.ERROR then
            notified = true
        end
    end
    if not notified then
        fail("connection timeout did not notify Neovim")
    end
elseif mode:match("^operations") then
    local prior_win = vim.api.nvim_get_current_win()
    local prior_tab = vim.api.nvim_get_current_tabpage()
    local listed_buf = vim.api.nvim_get_current_buf()
    vim.api.nvim_buf_set_name(listed_buf, "listed-test-buffer")
    if mode == "operations-fallback" then
        vim.api.nvim_open_win(listed_buf, true, {
            relative = "editor",
            row = 1,
            col = 1,
            width = 20,
            height = 5,
        })
    end
    vim.cmd("Pi")
    wait_for(function()
        return find_event("connected") ~= nil
    end, "fake Pi did not connect")
    local pi_win = vim.api.nvim_get_current_win()
    local pi_buf = vim.api.nvim_get_current_buf()
    wait_for(function()
        return find_event("response") ~= nil
    end, "Neovim did not respond to buffer-list request")
    local responses = {}
    for _, event in ipairs(events()) do
        if event.type == "response" then
            responses[event.response.id] = event.response
        end
    end
    local listed = assert(responses["list-1"], "buffer-list response is missing").result
    local found_listed, found_pi = false, false
    for _, buffer in ipairs(listed) do
        if
            buffer.buffer_id == listed_buf
            and buffer.path == vim.fn.fnamemodify("listed-test-buffer", ":p")
        then
            found_listed = true
        end
        if buffer.path == "Pi" then
            found_pi = true
        end
    end
    if not found_listed or found_pi then
        fail("buffer listing did not include the listed buffer while excluding Pi")
    end
    wait_for(function()
        for _, event in ipairs(events()) do
            if event.type == "response" then
                responses[event.response.id] = event.response
            end
        end
        return responses["open-invalid"] ~= nil
            and responses["open-plain"] ~= nil
            and responses["open-character"] ~= nil
            and responses["open-line"] ~= nil
            and responses["open-block"] ~= nil
            and responses["open-missing"] ~= nil
    end, "Neovim did not respond to file-open requests")
    if mode == "operations" and vim.api.nvim_get_current_win() ~= prior_win then
        fail("file did not open in the eligible prior window")
    elseif mode == "operations-fallback" then
        if vim.api.nvim_get_current_win() == prior_win then
            fail("file open reused an ineligible prior window")
        end
        if vim.api.nvim_get_current_tabpage() == prior_tab then
            fail("file open did not use the configured tab placement fallback")
        end
    end
    if vim.api.nvim_buf_get_name(0) ~= vim.fn.fnamemodify(operation_path, ":p") then
        fail("relative file path was not resolved against Pi's working directory")
    end
    local cursor = vim.api.nvim_win_get_cursor(0)
    if cursor[1] ~= 2 or cursor[2] ~= 3 then
        fail("requested source interval did not position the cursor")
    end
    if responses["open-invalid"].ok then
        fail("invalid selection request unexpectedly succeeded")
    end
    local invalid_buffer_opened = false
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
        if
            vim.api.nvim_buf_get_name(buf) == vim.fn.fnamemodify(operation_path .. ".invalid", ":p")
        then
            invalid_buffer_opened = true
        end
    end
    if invalid_buffer_opened then
        fail("invalid selection request opened its target file before failing")
    end
    if responses["open-missing"].ok or vim.fn.filereadable(".pi-nvim-missing-test") ~= 0 then
        fail("missing file request created a buffer or returned success")
    end
    local warned = false
    for _, notice in ipairs(notices) do
        if notice.level == vim.log.levels.WARN then
            warned = true
        end
    end
    if not warned then
        fail("missing file request did not issue a warning")
    end
    vim.cmd("Pi")
    if vim.api.nvim_get_current_win() ~= pi_win or vim.api.nvim_get_current_buf() ~= pi_buf then
        fail("opening a file replaced the managed Pi window reference")
    end
    vim.fn.delete(operation_path)
    vim.fn.delete(operation_path .. ".invalid")
elseif mode == "horizontal" or mode == "vertical" then
    local original_win = vim.api.nvim_get_current_win()
    local original_size = mode == "horizontal" and vim.api.nvim_win_get_height(original_win)
        or vim.api.nvim_win_get_width(original_win)
    local target_size = math.max(1, math.floor(original_size * 60 / 100))
    vim.cmd("Pi")
    wait_for(function()
        return find_event("connected") ~= nil
    end, "fake Pi did not connect")
    local pi_win = vim.api.nvim_get_current_win()
    local actual_size = mode == "horizontal" and vim.api.nvim_win_get_height(pi_win)
        or vim.api.nvim_win_get_width(pi_win)
    if actual_size ~= target_size then
        fail(string.format("%s split size was %d, expected %d", mode, actual_size, target_size))
    end
else
    local original_win = vim.api.nvim_get_current_win()
    vim.cmd("Pi")
    wait_for(function()
        return find_event("connected") ~= nil
    end, "fake Pi did not connect")
    if vim.api.nvim_get_current_win() == original_win then
        fail("Pi did not open its managed window")
    end
    local pi_win = vim.api.nvim_get_current_win()
    local pi_buf = vim.api.nvim_get_current_buf()

    vim.cmd("Pi hello from test")
    wait_for(function()
        return find_event("request", "submit_prompt") ~= nil
    end, "prompt was not sent to fake Pi")
    local prompt = find_event("request", "submit_prompt").request
    if prompt.prompt ~= "hello from test" then
        fail("command argument was not submitted intact")
    end

    vim.cmd("Pi")
    if vim.api.nvim_get_current_win() ~= original_win then
        fail("bare :Pi in the Pi window did not return to the previous window")
    end
    vim.cmd("Pi")
    wait_for(function()
        return vim.api.nvim_win_is_valid(pi_win)
            and vim.api.nvim_get_current_win() == pi_win
            and vim.api.nvim_get_current_buf() == pi_buf
    end, "repeated :Pi did not refocus the existing session")
    local starts = 0
    for _, event in ipairs(events()) do
        if event.type == "started" then
            starts = starts + 1
        end
    end
    if starts ~= 1 then
        fail("repeated :Pi invocation started more than one fake process")
    end

    vim.api.nvim_set_current_win(original_win)
    local source_buf = vim.api.nvim_get_current_buf()
    vim.api.nvim_buf_set_lines(source_buf, 0, -1, false, { "selection sample" })
    vim.api.nvim_win_set_cursor(original_win, { 1, 1 })
    vim.cmd("normal! gg0v15l")
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(":Pi<CR>", true, false, true), "xt", false)
    wait_for(function()
        return find_event("request", "insert_selection") ~= nil
    end, "visual selection was not sent to fake Pi")
    local selection = find_event("request", "insert_selection").request
    if selection.text ~= "selection sample" then
        fail("visual selection text was not transferred intact: " .. vim.inspect(selection))
    end
    if selection.selection.selection_type ~= "character" then
        fail("visual selection type metadata was not transferred")
    end
    if selection.selection.start_line ~= 1 or selection.selection.start_col ~= 1 then
        fail("visual selection start coordinates were not reported as 1-based")
    end
    if selection.selection.end_line ~= 1 or selection.selection.end_col ~= 16 then
        fail("visual selection end coordinates were not reported as 1-based")
    end
end

vim.notify = original_notify
vim.fn.delete(log)
if not mode:match("^operations") then
    vim.fn.delete(operation_path)
    vim.fn.delete(operation_path .. ".invalid")
end
vim.cmd("qa!")
