"use strict";

/**
 * A stand-in for the host API the desktop client injects as `globalThis.pi`.
 * Only the members this plugin uses are modelled, and every one of them is the
 * shape documented in docs/plugin-development.md §6.1 and §6.3.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function tempDataDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-web-access-${label}-`));
}

/**
 * @param {{ dataDir?: string, settings?: Record<string, unknown>, complete?: (input: object) => Promise<{ text: string }> }} [options]
 */
function createMockHost(options = {}) {
  const dataDir = options.dataDir ?? tempDataDir("host");
  const settingsStore = { ...(options.settings ?? {}) };
  const registered = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const completions = [];
  const panels = [];
  const calls = {
    registered: [],
    unregistered: [],
    settingsWrites: [],
    commandsRegistered: [],
    commandsUnregistered: [],
    openedExternal: [],
  };

  const pi = {
    agent: {
      async registerTool(definition) {
        registered.set(definition.name, definition);
        calls.registered.push(definition.name);
      },
      async unregisterTool(name) {
        registered.delete(name);
        calls.unregistered.push(name);
      },
      async complete(input) {
        completions.push(input);
        if (typeof options.complete === "function") return options.complete(input);
        return { text: `answer from ${input.modelKey}`, modelKey: input.modelKey };
      },
    },
    commands: {
      async register(definition) {
        commands.set(definition.id, definition);
        calls.commandsRegistered.push(definition.id);
      },
      async unregister(id) {
        commands.delete(id);
        calls.commandsUnregistered.push(id);
      },
    },
    keyboard: {
      async registerGlobalShortcut(input) {
        const entry = { ...input, registered: true };
        shortcuts.set(input.id, entry);
        return entry;
      },
      async unregisterGlobalShortcut(id) {
        shortcuts.delete(id);
      },
      async listGlobalShortcuts() {
        return [...shortcuts.values()];
      },
    },
    ui: {
      async openPanel(payload) {
        panels.push(payload ?? {});
      },
      async showToast() {},
    },
    shell: {
      async openExternal(url) {
        calls.openedExternal.push(url);
      },
    },
    plugin: {
      async getDataPath() {
        return dataDir;
      },
      async getSettings() {
        return { ...settingsStore };
      },
      async setSettings(patch) {
        calls.settingsWrites.push({ ...patch });
        Object.assign(settingsStore, patch);
      },
    },
  };

  return { pi, dataDir, registered, commands, shortcuts, completions, panels, calls, settingsStore };
}

module.exports = { createMockHost, tempDataDir };
