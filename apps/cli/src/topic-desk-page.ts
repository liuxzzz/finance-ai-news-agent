export function topicDeskPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>专题追踪与简报工作台</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1d1a16;
      --muted: #6b645b;
      --line: #e4dcd0;
      --paper: #f7f4ee;
      --card: #fffdf9;
      --accent: #8d3b2f;
      --ok: #1f6b45;
      --warn: #8a5a12;
      --bad: #8d2f2f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font: 15px/1.5 "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif;
    }
    header, main { padding: 20px 24px; }
    header { border-bottom: 1px solid var(--line); background: var(--card); }
    h1 { margin: 0 0 4px; font-size: 22px; font-weight: 650; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    p { margin: 0; }
    .muted { color: var(--muted); }
    .layout { display: grid; grid-template-columns: 280px 1fr; gap: 20px; }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 16px;
    }
    button, input, textarea {
      font: inherit;
      color: inherit;
    }
    button {
      background: var(--accent);
      color: white;
      border: 0;
      border-radius: 8px;
      padding: 8px 12px;
      cursor: pointer;
    }
    button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: white;
    }
    label { display: block; margin: 10px 0 4px; font-size: 13px; color: var(--muted); }
    .row { display: flex; gap: 8px; align-items: center; }
    .topic-button, .run-button {
      width: 100%;
      text-align: left;
      background: transparent;
      color: inherit;
      border: 1px solid transparent;
      margin-bottom: 6px;
    }
    .topic-button[aria-current="true"], .run-button[aria-current="true"] {
      border-color: var(--accent);
      background: #f8efe8;
    }
    .badge {
      display: inline-block;
      border-radius: 999px;
      padding: 1px 8px;
      font-size: 12px;
      background: #eee7dc;
    }
    .badge.running { background: #f3e2c2; color: var(--warn); }
    .badge.succeeded, .badge.ready { background: #e5f3ea; color: var(--ok); }
    .badge.failed, .badge.request_failed { background: #f8e4e4; color: var(--bad); }
    .badge.empty, .badge.deduped, .badge.filtered { background: #eee7dc; color: var(--muted); }
    .stack { display: grid; gap: 16px; }
    pre {
      white-space: pre-wrap;
      background: #1d1a16;
      color: #f7f4ee;
      border-radius: 10px;
      padding: 14px;
      overflow: auto;
    }
    .error { color: var(--bad); }
    .feeds { display: grid; gap: 4px; max-height: 180px; overflow: auto; }
    .hidden { display: none; }
    @media (max-width: 860px) {
      .layout { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>专题追踪与简报工作台</h1>
    <p class="muted" id="banner">正在连接本地服务…</p>
  </header>
  <main class="layout">
    <aside class="card">
      <div class="row" style="justify-content: space-between;">
        <h2>专题</h2>
        <button class="secondary" id="new-topic" type="button">新建</button>
      </div>
      <div id="topic-list"></div>
    </aside>
    <section class="stack">
      <form class="card" id="topic-form">
        <h2 id="form-title">新建专题</h2>
        <label for="name">名称</label>
        <input id="name" name="name" required maxlength="80" />
        <label for="keywords">关键词，用逗号分隔</label>
        <input id="keywords" name="keywords" required placeholder="利率, 央行" />
        <div class="row">
          <div style="flex:1">
            <label for="window">时间窗口（小时）</label>
            <input id="window" name="windowHours" type="number" min="1" max="168" value="48" />
          </div>
          <div style="flex:1">
            <label for="lookback">去重回看（天）</label>
            <input id="lookback" name="lookbackDays" type="number" min="0" max="30" value="7" />
          </div>
        </div>
        <label>目录来源</label>
        <div id="catalog" class="feeds"></div>
        <label for="custom-feeds">自定义来源，每行 id|url|名称</label>
        <textarea id="custom-feeds" rows="3" placeholder="local|http://127.0.0.1:9/feed.xml|本地夹具"></textarea>
        <label class="row"><input id="enabled" type="checkbox" checked style="width:auto" /> 启用</label>
        <div class="row">
          <button type="submit">保存专题</button>
          <button class="secondary" id="run-topic" type="button" disabled>生成简报</button>
        </div>
        <p class="error" id="form-error"></p>
      </form>
      <section class="card">
        <h2>运行历史</h2>
        <div id="history"></div>
      </section>
      <section class="card" id="detail">
        <h2>简报详情</h2>
        <p class="muted">选择一次运行后，这里显示来源、证据和简报。</p>
      </section>
    </section>
  </main>
  <script>
    const state = { topics: [], catalog: [], selectedId: null, editingId: null, runs: [], detail: null, timer: null };
    const topicList = document.querySelector("#topic-list");
    const history = document.querySelector("#history");
    const detail = document.querySelector("#detail");
    const formError = document.querySelector("#form-error");
    const form = document.querySelector("#topic-form");

    function badge(text) {
      const span = document.createElement("span");
      span.className = "badge " + text;
      span.textContent = text;
      return span;
    }

    function clear(node) {
      while (node.firstChild) node.removeChild(node.firstChild);
    }

    async function api(path, options) {
      const response = await fetch(path, options);
      if (response.status === 204) return null;
      const contentType = response.headers.get("content-type") || "";
      const body = contentType.includes("application/json") ? await response.json() : await response.text();
      if (!response.ok) {
        const message = body && body.error && body.error.message ? body.error.message : response.statusText;
        throw new Error(message);
      }
      return body;
    }

    function renderTopics() {
      clear(topicList);
      if (state.topics.length === 0) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "还没有专题。填写右侧表单后保存。";
        topicList.appendChild(empty);
        return;
      }
      for (const topic of state.topics) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "topic-button";
        button.setAttribute("aria-current", topic.id === state.selectedId ? "true" : "false");
        const title = document.createElement("div");
        title.textContent = topic.name;
        const meta = document.createElement("div");
        meta.className = "muted";
        meta.textContent = topic.keywords.join("、") + (topic.enabled ? "" : " · 已停用");
        button.append(title, meta);
        button.addEventListener("click", () => selectTopic(topic.id));
        topicList.appendChild(button);
      }
    }

    function renderHistory() {
      clear(history);
      if (state.selectedId === null) {
        history.appendChild(note("先选择或新建一个专题。"));
        return;
      }
      if (state.runs.length === 0) {
        history.appendChild(note("这个专题还没有运行。保存后可以生成简报。"));
        return;
      }
      for (const run of state.runs) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "run-button";
        button.setAttribute("aria-current", state.detail && state.detail.run.id === run.id ? "true" : "false");
        const line = document.createElement("div");
        line.className = "row";
        line.append(badge(run.status));
        if (run.outcome) line.append(badge(run.outcome));
        const when = document.createElement("span");
        when.className = "muted";
        when.textContent = run.startedAt;
        line.append(when);
        button.appendChild(line);
        button.addEventListener("click", () => loadDetail(run.id));
        history.appendChild(button);
      }
    }

    function note(text) {
      const paragraph = document.createElement("p");
      paragraph.className = "muted";
      paragraph.textContent = text;
      return paragraph;
    }

    function renderDetail() {
      clear(detail);
      const heading = document.createElement("h2");
      heading.textContent = "简报详情";
      detail.appendChild(heading);
      if (!state.detail) {
        detail.appendChild(note("选择一次运行后，这里显示来源、证据和简报。"));
        return;
      }
      const run = state.detail.run;
      const summary = document.createElement("p");
      summary.append(badge(run.status));
      summary.append(document.createTextNode(" "));
      if (run.outcome) {
        summary.append(badge(run.outcome));
        summary.append(document.createTextNode(" "));
      }
      summary.append(document.createTextNode(run.modelInvoked ? "模型 " + run.modelLabel : "未调用模型"));
      detail.appendChild(summary);
      if (run.status === "running") detail.appendChild(note("正在采集、过滤并生成简报。"));
      if (run.error) {
        const error = document.createElement("p");
        error.className = "error";
        error.textContent = run.error.name + ": " + run.error.message;
        detail.appendChild(error);
      }
      const sources = document.createElement("div");
      sources.className = "row";
      if (run.sourceOutcomes.length === 0) sources.appendChild(note("还没有来源结果。"));
      for (const source of run.sourceOutcomes) {
        const item = document.createElement("span");
        item.append(badge(source.outcome));
        item.append(document.createTextNode(" " + source.sourceId));
        sources.appendChild(item);
      }
      detail.appendChild(sources);
      const evidenceTitle = document.createElement("h2");
      evidenceTitle.textContent = "证据";
      detail.appendChild(evidenceTitle);
      if (run.evidence.length === 0) {
        detail.appendChild(note("这次运行没有留下新证据。"));
      }
      for (const item of run.evidence) {
        const block = document.createElement("p");
        const link = document.createElement("a");
        link.href = item.url;
        link.textContent = item.title;
        link.rel = "noreferrer";
        block.append(link, document.createTextNode(" · " + item.id));
        detail.appendChild(block);
      }
      if (state.detail.briefing) {
        const actions = document.createElement("p");
        const link = document.createElement("a");
        link.href = "/api/runs/" + run.id + "/export";
        link.textContent = "导出 Markdown";
        actions.appendChild(link);
        if (state.detail.briefing.exportPath) {
          actions.append(document.createTextNode(" · 已写入 " + state.detail.briefing.exportPath));
        }
        detail.appendChild(actions);
        const pre = document.createElement("pre");
        pre.textContent = state.detail.briefing.markdown;
        detail.appendChild(pre);
      }
    }

    async function refreshTopics() {
      state.topics = await api("/api/topics");
      renderTopics();
    }

    async function selectTopic(id) {
      state.selectedId = id;
      state.editingId = id;
      const topic = state.topics.find((item) => item.id === id);
      document.querySelector("#form-title").textContent = "编辑专题";
      document.querySelector("#name").value = topic.name;
      document.querySelector("#keywords").value = topic.keywords.join(", ");
      document.querySelector("#window").value = String(topic.windowHours);
      document.querySelector("#lookback").value = String(topic.lookbackDays);
      document.querySelector("#enabled").checked = topic.enabled;
      const catalogIds = new Set(state.catalog.map((feed) => feed.id));
      for (const input of document.querySelectorAll("#catalog input")) input.checked = false;
      const custom = [];
      for (const feed of topic.feeds) {
        if (catalogIds.has(feed.id)) {
          const box = document.querySelector('#catalog input[value="' + feed.id + '"]');
          if (box) box.checked = true;
        } else {
          custom.push([feed.id, feed.url, feed.name || ""].join("|"));
        }
      }
      document.querySelector("#custom-feeds").value = custom.join("\\n");
      document.querySelector("#run-topic").disabled = !topic.enabled;
      renderTopics();
      await refreshRuns();
    }

    async function refreshRuns() {
      if (state.selectedId === null) {
        state.runs = [];
        renderHistory();
        return;
      }
      state.runs = await api("/api/topics/" + state.selectedId + "/runs");
      renderHistory();
      const active = state.runs.find((run) => run.status === "running");
      if (active) {
        await loadDetail(active.id);
        schedulePoll();
        return;
      }
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      const openId = state.detail && state.detail.run.id;
      const listed = openId ? state.runs.find((run) => run.id === openId) : null;
      if (listed && state.detail.run.status !== listed.status) {
        await loadDetail(openId);
      }
    }

    function schedulePoll() {
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => { refreshRuns().catch(showError); }, 700);
    }

    async function loadDetail(id) {
      state.detail = await api("/api/runs/" + id);
      const index = state.runs.findIndex((run) => run.id === id);
      if (index >= 0) state.runs[index] = state.detail.run;
      renderHistory();
      renderDetail();
    }

    function selectedDraft() {
      const feedIds = [...document.querySelectorAll("#catalog input:checked")].map((input) => input.value);
      const customFeeds = document.querySelector("#custom-feeds").value.split(/\\n+/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const parts = line.split("|");
        const feed = { id: (parts[0] || "").trim(), url: (parts[1] || "").trim() };
        if ((parts[2] || "").trim()) feed.name = parts[2].trim();
        return feed;
      });
      return {
        name: document.querySelector("#name").value,
        keywords: document.querySelector("#keywords").value.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
        windowHours: Number(document.querySelector("#window").value),
        lookbackDays: Number(document.querySelector("#lookback").value),
        enabled: document.querySelector("#enabled").checked,
        feedIds: feedIds,
        customFeeds: customFeeds
      };
    }

    function showError(error) {
      formError.textContent = error instanceof Error ? error.message : String(error);
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      formError.textContent = "";
      const draft = selectedDraft();
      const path = state.editingId ? "/api/topics/" + state.editingId : "/api/topics";
      const method = state.editingId ? "PATCH" : "POST";
      api(path, { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(draft) })
        .then(async (topic) => {
          await refreshTopics();
          await selectTopic(topic.id);
        })
        .catch(showError);
    });

    document.querySelector("#new-topic").addEventListener("click", () => {
      state.editingId = null;
      state.selectedId = null;
      state.detail = null;
      state.runs = [];
      form.reset();
      document.querySelector("#window").value = "48";
      document.querySelector("#lookback").value = "7";
      document.querySelector("#enabled").checked = true;
      document.querySelector("#form-title").textContent = "新建专题";
      document.querySelector("#run-topic").disabled = true;
      renderTopics();
      renderHistory();
      renderDetail();
    });

    document.querySelector("#run-topic").addEventListener("click", () => {
      if (!state.selectedId) return;
      formError.textContent = "";
      document.querySelector("#run-topic").disabled = true;
      api("/api/topics/" + state.selectedId + "/runs", { method: "POST" })
        .then((run) => loadDetail(run.id))
        .then(() => refreshRuns())
        .catch(showError)
        .finally(() => {
          const topic = state.topics.find((item) => item.id === state.selectedId);
          document.querySelector("#run-topic").disabled = !topic || !topic.enabled;
        });
    });

    api("/api/health").then((health) => {
      document.querySelector("#banner").textContent = "模式 " + health.mode + " · 模型 " + health.modelLabel + " · 只监听 " + health.host + " · 不发送通知";
    }).catch(showError);
    api("/api/catalog").then((catalog) => {
      state.catalog = catalog;
      const box = document.querySelector("#catalog");
      for (const feed of catalog) {
        const label = document.createElement("label");
        label.className = "row";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = feed.id;
        input.style.width = "auto";
        label.append(input, document.createTextNode(feed.name + " · " + feed.topic));
        box.appendChild(label);
      }
    }).then(refreshTopics).catch(showError);
    renderHistory();
    renderDetail();
  </script>
</body>
</html>`;
}
