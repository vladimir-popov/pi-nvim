NODE ?= node
NVIM_BIN ?= nvim

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
	@set -e; \
	PI_INSTALL_ROOT="$${PI_MANAGED_INSTALL_ROOT:-$(HOME)/.pi/agent/install}"; \
	PI_NODE_MODULES="$$(find "$$PI_INSTALL_ROOT/releases" -path '*/node_modules/@earendil-works/pi-ai/package.json' -print -quit 2>/dev/null | xargs -r dirname | xargs -r dirname | xargs -r dirname)"; \
	if [ -z "$$PI_NODE_MODULES" ]; then echo "Could not find Pi dependencies under $$PI_INSTALL_ROOT/releases" >&2; exit 1; fi; \
	if [ -e pi/node_modules ] || [ -L pi/node_modules ]; then echo "pi/node_modules already exists; refusing to replace it" >&2; exit 1; fi; \
	trap 'rm -f pi/node_modules' EXIT; \
	ln -s "$$PI_NODE_MODULES" pi/node_modules; \
	$(NODE) --experimental-strip-types --test test/*.test.ts

test-nvim: check-node
	@echo
	@echo "Running Neovim plugin integration tests"
	@echo
	@set -e; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=connect $(NVIM_BIN) --headless -u NONE -c "lua dofile('test/nvim.lua')" >/dev/null; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=no-connect $(NVIM_BIN) --headless -u NONE -c "lua dofile('test/nvim.lua')" >/dev/null; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=horizontal $(NVIM_BIN) --headless -u NONE -c "lua dofile('test/nvim.lua')" >/dev/null; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=vertical $(NVIM_BIN) --headless -u NONE -c "lua dofile('test/nvim.lua')" >/dev/null; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=operations $(NVIM_BIN) --headless -u NONE -c "lua dofile('test/nvim.lua')" >/dev/null; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=operations-fallback $(NVIM_BIN) --headless -u NONE -c "lua dofile('test/nvim.lua')" >/dev/null; \
	PI_NVIM_TEST_ROOT="$(CURDIR)" PI_NVIM_FAKE_MODE=cursor-line $(NVIM_BIN) --headless -u NONE -c "lua dofile('test/nvim.lua')" >/dev/null; \
	echo "Neovim plugin integration tests passed"
