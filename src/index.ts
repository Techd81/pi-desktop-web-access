/** Bundle entry: everything the plugin process needs from TypeScript. */
export * from "./agent.ts";
export * from "./config.ts";
export * from "./core.ts";
export * from "./schema.ts";
export * from "./store.ts";
// Exported so the shim's PNG scaling can be tested through the same artifact the
// plugin ships, instead of a differently compiled copy.
export { resizeImage } from "./shims/pi-coding-agent.ts";
