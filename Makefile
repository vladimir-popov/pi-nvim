NODE ?= node
NVIM ?= nvim

.PHONY: test check-node test-node test-nvim

test: test-node test-nvim

check-node:
	$(NODE) -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 6)) { console.error("Node.js >=22.6.0 is required for native TypeScript stripping"); process.exit(1); }'

test-node: check-node
	$(NODE) --experimental-strip-types --test test/*.test.ts

test-nvim: check-node
	set -e; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=connect $(NVIM) --headless -u NONE -c "lua dofile('test/nvim.lua')"; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=no-connect $(NVIM) --headless -u NONE -c "lua dofile('test/nvim.lua')"; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=horizontal $(NVIM) --headless -u NONE -c "lua dofile('test/nvim.lua')"; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=vertical $(NVIM) --headless -u NONE -c "lua dofile('test/nvim.lua')"
