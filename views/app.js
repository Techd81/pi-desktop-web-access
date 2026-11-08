/**
 * Web Access panel.
 *
 * Talks to the plugin process through `window.pluginBridge.invoke(channel, …)`,
 * the documented panel bridge. All decisions that can be tested without a DOM
 * live in views/lib/model.js; this file only builds elements and moves state.
 */
(function () {
  "use strict";

  const model = window.WebAccessModel;

  const state = {
    status: null,
    availability: null,
    draft: null,
    forms: {},
    saving: false,
    error: "",
    saved: false,
    loading: true,
    /** Preview text and the source URL of the result last opened. */
    preview: null,
    previewUrl: "",
    /** A command's focus target is honoured once, not on every re-render. */
    focusApplied: false,
  };

  /* ------------------------------------------------------------------ dom */

  function mount() {
    return document.getElementById("app");
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function section(id, title) {
    const wrapper = make("section", "card");
    wrapper.id = id;
    wrapper.appendChild(make("h2", "card-title", title));
    const body = make("div", "card-body");
    wrapper.appendChild(body);
    return { wrapper, body };
  }

  function row(label, control, hint) {
    const wrapper = make("label", "field");
    wrapper.appendChild(make("span", "field-label", label));
    wrapper.appendChild(control);
    if (hint) wrapper.appendChild(make("span", "field-hint", hint));
    return wrapper;
  }

  function input(id, value, type) {
    const node = make("input", "input");
    node.id = id;
    node.type = type || "text";
    node.value = value === undefined || value === null ? "" : String(value);
    return node;
  }

  function button(id, label, action) {
    const node = make("button", "button", label);
    node.id = id;
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }

  /* ---------------------------------------------------------------- bridge */

  async function call(channel, payload) {
    const bridge = window.pluginBridge;
    if (!bridge || typeof bridge.invoke !== "function") throw new Error("插件桥接不可用");
    return bridge.invoke(channel, payload || {});
  }

  /* ---------------------------------------------------------------- render */

  function renderStatus(host) {
    const { body } = section("status", "状态");
    if (!state.status) {
      body.appendChild(make("p", "muted", state.loading ? "正在读取插件状态…" : "没有状态"));
      return host.appendChild(body.parentElement);
    }
    const status = state.status;
    const list = make("dl", "facts");
    const fact = (term, value) => {
      list.appendChild(make("dt", null, term));
      list.appendChild(make("dd", null, value));
    };
    fact("配置文件", status.configPath || "—");
    fact("数据目录", status.dataDir || "—");
    fact("配置来源", model.formatSourceSummary(status.applied));
    fact("旧配置文件", status.legacyPath || "无");
    fact("已注册工具", (status.registeredTools || []).join(", ") || "无");
    fact("命令", (status.commands || []).join(", ") || "无");
    fact(
      "快捷键",
      status.shortcut
        ? `${status.shortcut.accelerator}（${status.shortcut.registered ? "已注册" : status.shortcut.error || "未注册"}）`
        : "Ctrl/Cmd+Shift+Y（未注册）",
    );
    body.appendChild(list);

    const features = model.featureRows(status);
    body.appendChild(make("h3", "sub-title", "本机能力"));
    const chips = make("div", "chips");
    for (const item of features) {
      const chip = make("span", "chip");
      chip.dataset.feature = item.key;
      chip.dataset.available = item.available ? "true" : "false";
      chip.appendChild(make("span", "chip-name", item.label));
      chip.appendChild(make("span", "chip-state", item.available ? "可用" : "不可用"));
      if (!item.available) chip.classList.add("is-off");
      chips.appendChild(chip);
    }
    body.appendChild(chips);
    host.appendChild(body.parentElement);
  }

  function renderTools(host) {
    const { body } = section("tools", "工具");
    const status = state.status || {};
    const enabled = new Set(status.enabledTools || []);
    const registered = new Set(status.registeredTools || []);
    const grid = make("div", "chips");
    for (const name of ["web_search", "fetch_content", "get_search_content", "source_check"]) {
      const chip = make("span", "chip");
      chip.dataset.tool = name;
      chip.dataset.enabled = enabled.has(name) ? "true" : "false";
      chip.dataset.registered = registered.has(name) ? "true" : "false";
      chip.appendChild(make("span", "chip-name", name));
      chip.appendChild(make("span", "chip-state", registered.has(name) ? "已注册" : enabled.has(name) ? "未注册" : "已停用"));
      if (!enabled.has(name)) chip.classList.add("is-off");
      grid.appendChild(chip);
    }
    body.appendChild(grid);
    host.appendChild(body.parentElement);
  }

  function renderProviders(host) {
    const { body } = section("providers", "供应商可用性");
    const rows = model.resolveAvailabilityRows(state.availability || {}, (state.status && state.status.resolvedProviders) || []);
    if (rows.length === 0) {
      body.appendChild(make("p", "muted", "尚未读取可用性（点击刷新）"));
    } else {
      const grid = make("div", "provider-grid");
      for (const item of rows) {
        const cell = make("div", "provider");
        cell.dataset.provider = item.provider;
        cell.dataset.available = item.available ? "true" : "false";
        cell.appendChild(make("span", "dot"));
        cell.appendChild(make("span", "provider-name", item.provider));
        grid.appendChild(cell);
      }
      body.appendChild(grid);
      const available = rows.filter((item) => item.available).length;
      body.appendChild(make("p", "muted", `${available} / ${rows.length} 可用`));
    }
    body.appendChild(
      button("refresh-providers", "刷新可用性", async () => {
        await loadAvailability();
        render();
      }),
    );
    host.appendChild(body.parentElement);
  }

  function renderSettings(host) {
    const { body } = section("settings", "设置");
    const draft = state.draft || {};
    const form = make("div", "form");
    const bind = (key) => ({
      key,
      async onChange(value) {
        draft[key] = value;
        await saveSettings({ silent: true });
      },
    });

    const provider = input("setting-searchProvider", draft.searchProvider);
    provider.addEventListener("input", () => {
      draft.searchProvider = provider.value;
    });
    form.appendChild(row("默认搜索供应商", provider, "auto 自动选择，all 全部一起搜，也可填单个名称"));

    const mode = make("select", "input");
    mode.id = "setting-fetchDefaultMode";
    for (const value of model.FETCH_MODES) {
      const option = make("option", null, value);
      option.value = value;
      if (draft.fetchDefaultMode === value) option.selected = true;
      mode.appendChild(option);
    }
    mode.addEventListener("change", () => {
      draft.fetchDefaultMode = mode.value;
    });
    form.appendChild(row("抓取模式", mode, "answer 用当前会话模型回答；extract 需要调用时提供 fields"));

    const modeList = make("div", "checkboxes");
    for (const value of model.FETCH_MODES) {
      const wrapper = make("label", "checkbox");
      const box = make("input");
      box.type = "checkbox";
      box.id = `setting-mode-${value}`;
      box.checked = (draft.fetchAllowedModes || []).includes(value);
      box.addEventListener("change", () => {
        const current = new Set(draft.fetchAllowedModes || []);
        if (box.checked) current.add(value);
        else current.delete(value);
        draft.fetchAllowedModes = [...current];
      });
      wrapper.appendChild(box);
      wrapper.appendChild(make("span", null, value));
      modeList.appendChild(wrapper);
    }
    form.appendChild(row("允许的抓取模式", modeList));

    const chars = input("setting-maxInlineContentChars", draft.maxInlineContentChars, "number");
    chars.addEventListener("input", () => {
      draft.maxInlineContentChars = chars.value;
    });
    form.appendChild(row("内联内容字符上限", chars, "留空使用上游默认"));

    const proxy = input("setting-proxy", draft.proxy);
    proxy.addEventListener("input", () => {
      draft.proxy = proxy.value;
    });
    form.appendChild(row("代理", proxy, "留空表示直连"));

    const toggles = make("div", "checkboxes");
    for (const [key, label] of [
      ["enableWebSearch", "web_search"],
      ["enableSourceCheck", "source_check"],
      ["enableFetchContent", "fetch_content"],
      ["enableGetSearchContent", "get_search_content"],
    ]) {
      const wrapper = make("label", "checkbox");
      const box = make("input");
      box.type = "checkbox";
      box.id = `setting-${key}`;
      box.checked = draft[key] !== false;
      box.addEventListener("change", () => {
        draft[key] = box.checked;
      });
      wrapper.appendChild(box);
      wrapper.appendChild(make("span", null, label));
      toggles.appendChild(wrapper);
    }
    form.appendChild(row("启用工具", toggles, "改动后需重新加载插件才会重新注册"));

    form.appendChild(
      button("save-settings", "保存设置", () => saveSettings({ silent: false })),
    );
    body.appendChild(form);
    host.appendChild(body.parentElement);
    void bind;
  }

  function renderCredentials(host) {
    const { body } = section("credentials", "凭据");
    body.appendChild(
      make("p", "muted", "已保存的密钥只显示是否存在；输入新值即可替换，留空并保存表示清除。"),
    );
    const rows = model.credentialRows(state.status || {});
    if (rows.length === 0) body.appendChild(make("p", "muted", "插件尚未加载"));
    for (const item of rows) {
      const wrapper = make("div", "credential");
      wrapper.dataset.provider = item.provider;
      wrapper.appendChild(make("span", "credential-name", item.provider));
      wrapper.appendChild(make("span", "credential-state", item.configured ? "已配置" : "未配置"));
      const field = input(`credential-${item.field}`, "", "password");
      field.placeholder = item.field;
      field.autocomplete = "off";
      wrapper.appendChild(field);
      wrapper.appendChild(
        button(`credential-save-${item.field}`, "保存", async () => {
          await saveCredential(item.field, field.value);
          field.value = "";
          render();
        }),
      );
      wrapper.appendChild(
        button(`credential-clear-${item.field}`, "清除", async () => {
          await saveCredential(item.field, "");
          render();
        }),
      );
      body.appendChild(wrapper);
    }
    host.appendChild(body.parentElement);
  }

  function renderAdvanced(host) {
    const { body } = section("advanced", "密钥与高级配置（JSON）");
    body.appendChild(
      make("p", "muted", "上游任意配置键都可在此写入，例如 braveApiKey、fetchRouting、ssrf。写入后覆盖上面的同名项。"),
    );
    const area = make("textarea", "textarea");
    area.id = "advanced-json";
    area.rows = 6;
    area.placeholder = '{ "braveApiKey": "…" }';
    body.appendChild(area);
    body.appendChild(
      button("advanced-save", "应用 JSON", async () => {
        const reply = await call("advanced:save", { json: area.value });
        const outcome = model.describeReply(reply);
        if (outcome.ok) {
          area.value = "";
          await reload();
        } else {
          Object.assign(state, model.applySaveFailure(state, outcome.message));
          render();
        }
      }),
    );
    host.appendChild(body.parentElement);
  }

  /** Copies text when the sandbox allows it; false means "show it instead". */
  async function copyText(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      // A panel sandbox may refuse the clipboard; the caller falls back to the preview pane.
    }
    return false;
  }

  function renderResults(host) {
    const { body } = section("results", "已存结果");
    body.appendChild(
      make("p", "muted", "每次搜索或抓取都会返回一个 responseId；结果已落盘，重启后仍可用 get_search_content 取回。"),
    );
    const rows = model.resultRows(state.status || {});
    if (rows.length === 0) {
      body.appendChild(make("p", "muted", "还没有已存结果"));
    } else {
      const list = make("div", "result-list");
      for (const item of rows) {
        const line = make("div", "result");
        line.dataset.id = item.id;
        line.dataset.type = item.type;
        line.appendChild(make("span", "result-type", item.type));
        const label = make("span", "result-label", item.label);
        label.title = item.label;
        line.appendChild(label);
        line.appendChild(make("span", "result-meta", `${item.when} · ${item.size}`));
        line.appendChild(
          button(`result-peek-${item.id}`, "预览", async () => {
            const reply = await call("results:peek", { id: item.id });
            const found = reply && reply.ok === true && reply.result;
            state.preview = found ? model.previewText(reply.result) || "（这条结果没有可预览的正文）" : "（读不到这条结果）";
            const pages = found && Array.isArray(reply.result.urls) ? reply.result.urls : [];
            state.previewUrl = pages.length > 0 && typeof pages[0].url === "string" ? pages[0].url : "";
            render();
          }),
        );
        line.appendChild(
          button(`result-copy-${item.id}`, "复制 ID", async () => {
            const copied = await copyText(item.id);
            if (!copied) {
              state.preview = item.id;
              state.previewUrl = "";
              render();
            }
          }),
        );
        line.appendChild(
          button(`result-drop-${item.id}`, "删除", async () => {
            await call("results:drop", { id: item.id });
            // The preview may be showing the row that was just removed.
            state.preview = null;
            state.previewUrl = "";
            await reload();
          }),
        );
        list.appendChild(line);
      }
      body.appendChild(list);

      const actions = make("div", "row-actions");
      actions.appendChild(
        button("results-clear", "清空已存结果", async () => {
          await call("results:clear", {});
          state.preview = null;
          state.previewUrl = "";
          await reload();
        }),
      );
      actions.appendChild(
        button("results-repair", "重建索引", async () => {
          await call("results:repair", {});
          await reload();
        }),
      );
      body.appendChild(actions);
    }

    if (state.previewUrl) {
      body.appendChild(
        button("result-open", "在浏览器中打开这条结果的来源", async () => {
          const reply = await call("open:external", { url: state.previewUrl });
          const outcome = model.describeReply(reply);
          if (!outcome.ok) {
            Object.assign(state, model.applySaveFailure(state, outcome.message));
            render();
          }
        }),
      );
    }

    const pane = make("pre", "preview");
    pane.id = "result-preview";
    pane.textContent = state.preview === null ? "点「预览」查看一条结果的前 2000 字符。" : state.preview;
    body.appendChild(pane);
    host.appendChild(body.parentElement);
  }

  function renderActivity(host) {
    const { body } = section("activity", "活动");
    const rows = model.activityRows(state.status || {});
    if (rows.length === 0) {
      body.appendChild(make("p", "muted", "本次进程内还没有调用记录"));
    } else {
      const list = make("div", "activity-list");
      for (const item of rows) {
        const line = make("div", "activity");
        line.dataset.kind = item.kind;
        line.appendChild(make("span", "activity-kind", item.kind));
        line.appendChild(make("span", "activity-label", item.label));
        if (item.detail) line.appendChild(make("span", "activity-detail", item.detail));
        line.appendChild(make("span", "activity-when", item.when));
        list.appendChild(line);
      }
      body.appendChild(list);
    }
    host.appendChild(body.parentElement);
  }

  function renderError(host) {
    const problems = [...((state.status && Array.isArray(state.status.errors)) ? state.status.errors : [])];
    if (state.error) problems.unshift(state.error);
    // A save that worked used to be silent: `state.saved` was set but never
    // rendered, so the only feedback was the absence of an error line.
    const saved = problems.length === 0 && state.saved === true;
    const bar = make("div", saved ? "notice" : "error", saved ? "已保存" : "");
    bar.id = "error";
    bar.hidden = problems.length === 0 && !saved;
    for (const problem of problems) bar.appendChild(make("div", "error-line", problem));
    host.appendChild(bar);
  }

  /** A command names the section to open; honour each new target once. */
  function applyFocus() {
    const focus = state.status && typeof state.status.focus === "string" ? state.status.focus : "";
    // Comparing against the last value applied (not a boolean latch) means a
    // second command that targets the same section does not scroll again, while
    // a command that targets a different section still lands.
    if (focus === "" || focus === state.focusApplied) return;
    state.focusApplied = focus;
    const id = focus === "results" ? "results" : focus === "settings" ? "settings" : "status";
    const target = document.getElementById(id);
    if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
  }

  function render() {
    const host = mount();
    if (!host) return;
    clear(host);
    renderError(host);
    renderStatus(host);
    renderResults(host);
    renderActivity(host);
    renderTools(host);
    renderProviders(host);
    renderSettings(host);
    renderCredentials(host);
    renderAdvanced(host);
    applyFocus();
  }

  /* ----------------------------------------------------------------- flow */

  async function saveSettings(options) {
    const patch = model.buildSettingsPatch(state.draft || {});
    state.saving = true;
    if (!options || !options.silent) render();
    const reply = await call("settings:save", patch);
    const outcome = model.describeReply(reply);
    Object.assign(state, outcome.ok ? model.applySaveSuccess(state) : model.applySaveFailure(state, outcome.message));
    if (outcome.ok) await reload();
    else render();
  }

  async function saveCredential(field, value) {
    const reply = await call("secret:set", { field, value });
    const outcome = model.describeReply(reply);
    if (outcome.ok) await reload();
    else {
      Object.assign(state, model.applySaveFailure(state, outcome.message));
      render();
    }
  }

  async function loadStatus() {
    const reply = await call("status", {});
    const outcome = model.describeReply(reply);
    if (!outcome.ok) throw new Error(outcome.message);
    state.status = reply;
    state.draft = model.buildSettingsDraft(state.status);
  }

  async function loadAvailability() {
    try {
      const reply = await call("availability", {});
      state.availability = (reply && reply.availability) || {};
    } catch (error) {
      state.availability = {};
      state.error = error instanceof Error ? error.message : String(error);
    }
  }

  async function reload() {
    await loadStatus();
    await loadAvailability();
    state.loading = false;
    render();
  }

  async function init() {
    try {
      await reload();
    } catch (error) {
      state.loading = false;
      Object.assign(state, model.applySaveFailure(state, error instanceof Error ? error.message : String(error)));
      render();
    }
  }

  window.__webAccessActions = {
    saveSettings,
    saveCredential,
    reload,
    getState: () => state,
  };
  if (typeof window.__webAccessReady === "undefined") window.__webAccessReady = init();
})();
