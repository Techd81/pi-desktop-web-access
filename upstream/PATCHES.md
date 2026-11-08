# Upstream patch whitelist

Every file under `upstream/` is vendored byte-for-byte from
[`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access) at commit
`6dd57b7f5a0c3041053e65a28f5f425323ec95f9` (v0.47.0) and checked by
`npm run verify:upstream`.

**No file is patched.** The port reuses upstream through its own host-neutral
entry points (`createStandaloneWebToolCore`, `MCP_TOOL_DEFINITIONS`), so the
adapter never needs to edit upstream source.

A future change that genuinely has to modify an upstream file must be added to
the table below, with the reason and the upstream issue it works around. The
verification script treats any row here as an allowed difference and reports the
rest as failures.

| File | Reason |
| --- | --- |
