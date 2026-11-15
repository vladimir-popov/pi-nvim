NODE ?= node
NVIM ?= nvim

.PHONY: test check-node test-node test-nvim fmt lua js

test: test-node test-nvim

fmt:
	@case "$(filter lua js,$(MAKECMDGOALS))" in \
		"") stylua lua/ && npx --no-install prettier --write 'pi/**/*.{js,ts}' ;; \
		lua) stylua lua/ ;; \
		ts) npx --no-install prettier --write 'pi/**/*.{js,ts}' ;; \
		*) echo "Usage: make fmt [lua|js]" >&2; exit 2 ;; \
	esac

lua ts:
	@:

check-node:
	@$(NODE) -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 6)) { console.error("Node.js >=22.6.0 is required for native TypeScript stripping"); process.exit(1); }'

test-node: check-node
	@echo
	@echo "Running Pi extension tests"
	@echo
	@$(NODE) --experimental-strip-types --test test/*.test.ts

test-nvim: check-node
	@echo
	@echo "Running Neovim plugin integration tests"
	@echo
	@set -e; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=connect $(NVIM) --headless -u NONE -c "lua dofile('test/nvim.lua')" >/dev/null; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=no-connect $(NVIM) --headless -u NONE -c "lua dofile('test/nvim.lua')" >/dev/null; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=horizontal $(NVIM) --headless -u NONE -c "lua dofile('test/nvim.lua')" >/dev/null; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=vertical $(NVIM) --headless -u NONE -c "lua dofile('test/nvim.lua')" >/dev/null; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=operations $(NVIM) --headless -u NONE -c "lua dofile('test/nvim.lua')" >/dev/null; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=operations-fallback $(NVIM) --headless -u NONE -c "lua dofile('test/nvim.lua')" >/dev/null; \
	echo "Neovim plugin integration tests passed"
