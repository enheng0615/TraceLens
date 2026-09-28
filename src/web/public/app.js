const state = {
  jobs: [],
  activeJobId: null,
  activeArtifact: null,
  activeSessionKey: null,
  activeCriterionKey: null,
  batchSessionQuery: "",
  batchSessionStatus: "all",
  selectedBatchSessions: new Set(),
  currentJob: null,
  detailReturnView: "reports",
  csvFile: null,
  poll: null,
  activeJobStatus: null,
  retryJob: null,
  retryScope: null,
};

const titles = { workspace: "Trace RCA", "session-new": "单 Session 归因", "csv-new": "批量 CSV 归因", reports: "归因报告", history: "运行历史", detail: "报告详情", settings: "运行配置" };
const statusNames = {
  queued: "等待处理", running: "运行中", completed: "已完成", completed_with_evidence_gaps: "完成 · Trace局部不完整", completed_with_failures: "部分失败",
  completed_no_action: "无需归因", source_run_failed: "源任务未运行", failed: "失败", cancelled: "已取消",
};
const stageNames = {
  bootstrap: "初始化", scoring_gap: "评分差距", trace_map: "执行地图", final_rca: "最终报告",
  complete: "完成", failed: "失败", source_run: "源任务状态", resume: "断点恢复", investigation_stop: "调查停止",
  input_validation: "输入校验", ingestion: "Trace采集", preparation: "归因准备", investigation: "Trace调查", planned: "等待调度",
};

function renderFailureDiagnosis(job) {
  const diagnosis = job.failureDiagnosis;
  if (!diagnosis || !["failed", "completed_with_failures"].includes(job.status)) return "";
  const issue = diagnosis.inputInspection?.issues?.[0];
  return `<section class="failure-diagnosis" role="alert" aria-labelledby="failure-diagnosis-title">
    <div class="failure-diagnosis-head"><span>${icon("stop")}</span><div><small>${escapeHtml(diagnosis.stageLabel || "任务失败")}${diagnosis.code ? ` · ${escapeHtml(diagnosis.code)}` : ""}</small><h3 id="failure-diagnosis-title">${escapeHtml(diagnosis.message || "任务执行失败")}</h3></div></div>
    <div class="failure-diagnosis-grid"><div><strong>影响范围</strong><p>${escapeHtml(diagnosis.impact || "查看日志确认影响范围。")}</p></div><div><strong>处理建议</strong><p>${escapeHtml(diagnosis.remediation || "修复后创建新的Attempt。")}</p></div></div>
    ${issue ? `<p class="failure-diagnosis-meta">CSV 第 ${escapeHtml(issue.rowNumber)} 行 · 字段 ${escapeHtml(issue.field)} · 分数状态 ${escapeHtml(issue.scoreState)}</p>` : ""}
  </section>`;
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function toast(message) {
  const target = $("#toast");
  target.textContent = message;
  target.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => target.classList.remove("show"), 2800);
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json", ...(options.headers || {}) }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function showView(name) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `${name}-view`));
  $$(".nav-link[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  document.title = `${titles[name] || "Trace RCA"} - Trace RCA`;
  window.scrollTo({ top: 0, behavior: "instant" });
  if (name !== "detail") {
    state.activeJobId = null;
    clearInterval(state.poll);
  }
  $("#main").focus({ preventScroll: true });
}

function statusBadge(status) {
  return `<span class="status ${escapeHtml(status)}">${escapeHtml(statusNames[status] || status)}</span>`;
}

function jobTitle(job) {
  const base = job.type === "session" ? `Session ${job.inputSummary.sessionId}` : job.inputSummary.fileName || "CSV 批量任务";
  const attempt = Number(job.lineage?.attempt) || 1;
  return attempt > 1 ? `${base} · Attempt ${attempt}` : base;
}

function jobRows(jobs) {
  if (!jobs.length) return `<div class="empty-list"><strong>还没有归因任务</strong>从单 Session 或 CSV 创建第一条全链路运行。</div>`;
  return jobs.map((job) => `
    <button class="job-row" data-job-id="${escapeHtml(job.id)}">
      <span class="job-main"><span class="job-icon">${icon(job.type === "csv" ? "file" : "grid")}</span><span class="job-copy"><strong>${escapeHtml(jobTitle(job))}</strong><small>${job.type === "session" ? "单 Session 归因" : "批量评测归因"}</small></span></span>
      <span class="job-meta"><small>当前阶段</small><code>${escapeHtml(job.progress?.label || "等待状态")}</code></span>
      ${statusBadge(job.status)}
      <time>${formatTime(job.createdAt)}</time>
      ${icon("chevron")}
    </button>`).join("");
}

function bindJobRows() {
  $$('[data-job-id]').forEach((row) => row.addEventListener("click", () => openJob(row.dataset.jobId, row.dataset.origin || "history")));
}

function updateDashboard() {
  const running = state.jobs.filter((job) => ["queued", "running"].includes(job.status)).length;
  const completed = state.jobs.filter((job) => ["completed", "completed_with_evidence_gaps", "completed_no_action"].includes(job.status)).length;
  const failed = state.jobs.filter((job) => ["failed", "completed_with_failures"].includes(job.status)).length;
  $("#metric-running").textContent = running;
  $("#metric-completed").textContent = completed;
  $("#metric-failed").textContent = failed;
  $("#job-count").textContent = state.jobs.length;
  $("#recent-jobs").innerHTML = jobRows(state.jobs.slice(0, 5));
  renderHistory();
  renderReports();
  bindJobRows();
}

function renderHistory() {
  const query = $("#history-search")?.value?.trim().toLowerCase() || "";
  const jobs = state.jobs.filter((job) => !query || JSON.stringify(job.inputSummary).toLowerCase().includes(query) || job.id.toLowerCase().includes(query));
  $("#history-jobs").innerHTML = jobRows(jobs);
}

function reportRows(jobs) {
  if (!jobs.length) return `<div class="empty-list"><strong>还没有可查看的批次</strong>创建单 Session 或 CSV 任务后，批次报告会显示在这里。</div>`;
  return jobs.map((job) => {
    const attempt = Number(job.lineage?.attempt) || 1;
    const subject = job.type === "session" ? `Session ${job.inputSummary.sessionId || "—"}` : job.inputSummary.fileName || "CSV 批次";
    return `<button class="job-row report-row" data-job-id="${escapeHtml(job.id)}" data-origin="reports">
      <span class="job-main"><span class="job-icon">${icon("folder")}</span><span class="job-copy"><strong>批次 ${formatTime(job.createdAt)}</strong><small>${escapeHtml(subject)} · Attempt ${attempt}</small></span></span>
      <span class="job-meta"><small>报告状态</small><code>${escapeHtml(job.progress?.label || "等待生成")}</code></span>
      ${statusBadge(job.status)}<time>${formatTime(job.updatedAt || job.createdAt)}</time>${icon("chevron")}
    </button>`;
  }).join("");
}

function renderReports() {
  const query = $("#report-search")?.value?.trim().toLowerCase() || "";
  const jobs = state.jobs.filter((job) => {
    const searchable = `${job.id} ${JSON.stringify(job.inputSummary)} ${formatTime(job.createdAt)}`.toLowerCase();
    return !query || searchable.includes(query);
  });
  $("#report-jobs").innerHTML = reportRows(jobs);
}

async function loadJobs() {
  const { jobs } = await api("/api/jobs");
  state.jobs = jobs;
  updateDashboard();
}

function setFormError(target, error) {
  target.hidden = !error;
  target.textContent = error || "";
  if (error) target.focus();
}

function setSubmitting(form, busy) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = busy;
  button.style.opacity = busy ? ".58" : "";
  button.textContent = busy ? "正在创建任务…" : form.id === "session-form" ? "开始全链路归因" : "开始批量归因";
}

async function submitSession(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = $("#session-errors");
  setFormError(errorBox, "");
  const payload = {
    sessionId: $("#session-id").value,
    score: $("#score").value,
    query: $("#query").value,
    gt: $("#gt").value,
    machineGrading: $("#machine-grading").value,
    idaAnswer: $("#ida-answer").value,
    maxRounds: $("#max-rounds").value,
    mode: $("#run-mode").value,
    forceIngestion: $("#force-ingestion").checked,
  };
  const missing = [];
  if (!/^\d+$/.test(payload.sessionId.trim())) missing.push("Session ID 必须为数字");
  if (!payload.machineGrading.trim()) missing.push("机评结果不能为空");
  if (!payload.idaAnswer.trim()) missing.push("IDA 最终答案不能为空");
  if (missing.length) return setFormError(errorBox, missing.join("；"));
  try {
    setSubmitting(form, true);
    const { job } = await api("/api/jobs/session", { method: "POST", body: JSON.stringify(payload) });
    toast("任务已启动，正在准备 Trace");
    await loadJobs();
    await openJob(job.id);
  } catch (error) { setFormError(errorBox, error.message); }
  finally { setSubmitting(form, false); }
}

async function submitCsv(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = $("#csv-errors");
  setFormError(errorBox, "");
  if (!state.csvFile) return setFormError(errorBox, "请选择CSV文件");
  try {
    setSubmitting(form, true);
    const csvText = await state.csvFile.text();
    const { job } = await api("/api/jobs/csv", { method: "POST", body: JSON.stringify({
      fileName: state.csvFile.name,
      csvText,
      maxRounds: $("#csv-max-rounds").value,
      concurrency: $("#csv-concurrency").value,
      mode: $("#csv-run-mode").value,
      failFast: $("#fail-fast").checked,
    }) });
    toast("批量任务已启动");
    await loadJobs();
    await openJob(job.id);
  } catch (error) { setFormError(errorBox, error.message); }
  finally { setSubmitting(form, false); }
}

function chooseCsv(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".csv")) return setFormError($("#csv-errors"), "请选择.csv文件");
  if (file.size > 20 * 1024 * 1024) return setFormError($("#csv-errors"), "CSV不能超过20MB");
  state.csvFile = file;
  $("#file-preview").hidden = false;
  $("#file-preview").innerHTML = `<strong>${escapeHtml(file.name)}</strong> · ${(file.size / 1024).toFixed(1)} KB`;
  setFormError($("#csv-errors"), "");
}

function phaseLabel(event) {
  const webLabels = {
    job_created: "Web任务已创建",
    retry_created: "Web复跑已创建",
    process_started: "任务进程已启动",
    process_stdout: "进程标准输出",
    process_stderr: "进程错误输出",
    process_start_failed: "任务进程启动失败",
    process_exited: "任务进程已退出",
    failure_diagnosed: "Web失败诊断",
    cancel_requested: "停止任务",
  };
  if (event.phase === "web") return webLabels[event.type] || "Web运行事件";
  if (event.phase?.startsWith("investigation_round_")) return `调查轮次 ${event.phase.split("_").at(-1)}`;
  return stageNames[event.phase] || event.phase || event.type;
}

function renderEvents(events) {
  const target = $("#event-timeline");
  if (!events.length) {
    target.innerHTML = `<div class="empty-list"><strong>等待 Agent 事件</strong>任务启动后会逐步显示模型请求、工具行动与校验结果。</div>`;
    return;
  }
  target.innerHTML = events.map((event) => {
    const tone = event.level === "error" || /failed|error|rejected|stderr/.test(event.type) ? "failure" : /passed|complete|exited/.test(event.type) ? "success" : "";
    return `<article class="event ${tone}"><div class="event-head"><strong>${escapeHtml(phaseLabel(event))}</strong><time>${formatTime(event.timestamp)}</time></div><p>${escapeHtml(event.summary || event.type)}</p></article>`;
  }).join("");
  target.scrollTop = target.scrollHeight;
}

function sessionLabel(session) {
  return session.sessionId ? `Session ${session.sessionId}` : `CSV 行 ${session.rowNumbers?.[0] || session.key}`;
}

function sessionRowLabel(session) {
  const rows = session.rowNumbers || [];
  return rows.length ? `CSV 行 ${rows.join("、")}` : "无 CSV 行号";
}

function normalizedSessionStatus(session) {
  return session.status === "completed_with_failures" ? "failed" : (session.status || "running");
}

function updateBatchSelectionControls() {
  $("#batch-selection-count").textContent = `已选择 ${state.selectedBatchSessions.size} 个 Session`;
  $("#batch-retry-selected").disabled = state.selectedBatchSessions.size === 0;
}

function sessionEvents(job, session) {
  if (!session) return [];
  const id = String(session.sessionId || "");
  const rows = new Set((session.rowNumbers || []).map(String));
  return [...(job.webEvents || []), ...(job.events || [])].filter((event) => {
    const data = event.data || {};
    if (id && (String(data.sessionId || "") === id || JSON.stringify(data).includes(id) || String(event.summary || "").includes(id))) return true;
    return rows.has(String(data.rowNumber || ""));
  });
}

function renderBatchSessionOverview(job) {
  const panel = $("#batch-session-overview");
  if (job.type !== "csv") { panel.hidden = true; return; }
  panel.hidden = false;
  const sessions = job.reportTree?.sessions || [];
  const selectionEnabled = job.retry?.canRetrySelectedSessions === true;
  const selectable = new Map((selectionEnabled ? job.retry?.selectableSessions || [] : []).map((item) => [item.retryKey, item]));
  for (const key of [...state.selectedBatchSessions]) if (!selectable.has(key)) state.selectedBatchSessions.delete(key);
  const query = state.batchSessionQuery.trim().toLowerCase();
  const status = state.batchSessionStatus;
  const visible = sessions.filter((session) => {
    const label = `${sessionLabel(session)} ${(session.rowNumbers || []).join(" ")}`.toLowerCase();
    const current = normalizedSessionStatus(session);
    const statusMatch = status === "all" || current === status || (status === "failed" && session.counts?.failed > 0);
    return (!query || label.includes(query)) && statusMatch;
  });
  const count = (name) => sessions.filter((item) => normalizedSessionStatus(item) === name || (name === "failed" && item.counts?.failed > 0)).length;
  const totalRows = Number(job.reportTree?.counts?.nonFullScoreRows) || sessions.length;
  const startedRows = Math.min(totalRows, Number(job.reportTree?.counts?.startedRows) || 0);
  $("#batch-session-summary").textContent = `${formatTime(job.reportTree?.batch?.createdAt || job.createdAt)} · 仅展示当前批次 · ${startedRows}/${totalRows} 已进入处理 · 满分题不展示`;
  $("#batch-session-stats").innerHTML = [
    ["all", "非满分题", totalRows], ["queued", "等待处理", count("queued")], ["running", "运行中", count("running")],
    ["completed", "已完成", count("completed")], ["completed_with_evidence_gaps", "Trace有缺口", count("completed_with_evidence_gaps")], ["failed", "失败", count("failed")],
    ["source_run_failed", "源任务未运行", count("source_run_failed")],
  ].map(([key,label,value]) => `<button class="batch-stat ${state.batchSessionStatus === key ? "active" : ""}" data-batch-status="${key}"><strong>${value}</strong><span>${label}</span></button>`).join("");
  const selectionPanel = $("#batch-session-selection");
  selectionPanel.hidden = !selectionEnabled;
  updateBatchSelectionControls();
  $("#batch-session-grid").innerHTML = visible.length ? visible.map((session) => `
    <article class="batch-session-card ${session.key === state.activeSessionKey ? "active" : ""} ${state.selectedBatchSessions.has(session.retryKey) ? "selected" : ""}">
      <span class="batch-session-card-head"><span class="batch-session-leading">${selectable.has(session.retryKey) ? `<label class="batch-session-check"><input type="checkbox" data-batch-select="${escapeHtml(session.retryKey)}" ${state.selectedBatchSessions.has(session.retryKey) ? "checked" : ""}><span class="sr-only">选择 ${escapeHtml(sessionLabel(session))} 进行重跑</span></label>` : ""}<span class="session-node-icon">${icon("session")}</span></span>${statusBadge(session.status)}</span>
      <strong>${escapeHtml(sessionLabel(session))}</strong>
      <span class="batch-session-row">${escapeHtml(sessionRowLabel(session))}</span>
      <small>${session.issue ? escapeHtml(session.issue.label || "源任务没有可归因结果") : `${session.counts.criteria} 个 GT · ${session.counts.completed} 完成 · ${session.counts.failed} 失败`}</small>
      <button type="button" class="batch-session-open" data-batch-session="${escapeHtml(session.key)}">查看该 Session ${icon("chevron")}</button>
    </article>`).join("") : `<div class="empty-list batch-empty"><strong>没有符合条件的 Session</strong>调整搜索词或状态筛选。</div>`;
  $("#batch-session-search").value = state.batchSessionQuery;
  $("#batch-session-status").value = state.batchSessionStatus;
  $$('[data-batch-status]').forEach((button) => button.addEventListener("click", () => { state.batchSessionStatus = button.dataset.batchStatus; renderBatchSessionOverview(job); }));
  $$('[data-batch-select]').forEach((checkbox) => checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.selectedBatchSessions.add(checkbox.dataset.batchSelect);
    else state.selectedBatchSessions.delete(checkbox.dataset.batchSelect);
    checkbox.closest(".batch-session-card")?.classList.toggle("selected", checkbox.checked);
    updateBatchSelectionControls();
  }));
  $$('[data-batch-session]').forEach((button) => button.addEventListener("click", () => {
    state.activeSessionKey = button.dataset.batchSession;
    state.activeCriterionKey = null;
    state.activeArtifact = null;
    renderBatchSessionOverview(job);
    renderReportWorkspace(job);
    const selected = findReportSelection(job);
    renderEvents(sessionEvents(job, selected.session));
    if (selected.criterion?.preferredArtifact) loadArtifact(job.id, selected.criterion.preferredArtifact.path);
    document.querySelector(".report-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

function renderAttemptChain(job) {
  const attempts = [
    { id: job.id, status: job.status, attempt: Number(job.lineage?.attempt) || 1, scope: job.lineage?.scope || "initial", current: true },
    ...(job.relatedJobs || []),
  ].sort((a, b) => a.attempt - b.attempt);
  if (attempts.length <= 1) return "";
  return `<div class="attempt-chain"><span>运行链</span>${attempts.map((item) => `<button class="attempt-chip ${item.current ? "current" : ""}" data-related-job="${escapeHtml(item.id)}"><strong>A${item.attempt}</strong><small>${escapeHtml(item.scope === "failed_only" ? "失败项复跑" : item.scope === "selected_sessions" ? "指定Session复跑" : item.scope === "full" ? "完整重跑" : "首次运行")}</small>${statusBadge(item.status)}</button>`).join("")}</div>`;
}

function renderDetailHeader(job) {
  const canCancel = ["queued", "running"].includes(job.status);
  const progress = Math.max(0, Math.min(100, Number(job.progress?.percent) || 0));
  const canRetryFailed = job.retry?.canRetryFailed;
  const canRetryFull = job.retry?.canRetryFull;
  const attempt = Number(job.lineage?.attempt) || 1;
  const attemptMeta = attempt > 1 ? ` · Attempt ${attempt} · ${job.lineage.scope === "failed_only" ? "仅失败项" : job.lineage.scope === "selected_sessions" ? "指定Session" : "完整重跑"}` : " · Attempt 1";
  $("#detail-header").innerHTML = `
    <div class="detail-title-row"><div><span class="detail-kicker">${escapeHtml(job.type.toUpperCase())} / ${escapeHtml(job.id)}${escapeHtml(attemptMeta)}</span><h2>${escapeHtml(jobTitle(job))}</h2><p>${escapeHtml(job.error || job.progress?.label || "正在准备运行")}</p></div><div class="detail-actions"><button class="button ghost" id="back-to-history">返回</button>${canRetryFailed ? `<button class="button retry-primary" id="retry-failed">${icon("retry")}仅重跑失败项</button>` : ""}${canRetryFull ? `<button class="button ghost" id="retry-full">完整重跑</button>` : ""}${canCancel ? `<button class="button danger" id="cancel-job">${icon("stop")}停止任务</button>` : ""}</div></div>
    ${renderAttemptChain(job)}
    ${job.chainSummary?.total ? `<div class="chain-summary"><span>运行链有效结果</span><strong>${job.chainSummary.completed}/${job.chainSummary.total} 完成</strong><small>${job.chainSummary.failed} 未解决 · ${job.chainSummary.running} 运行中 · ${job.chainSummary.skipped} 跳过${job.chainSummary.sourceRunFailed ? ` · ${job.chainSummary.sourceRunFailed} 源任务未运行` : ""}</small></div>` : ""}
    ${renderFailureDiagnosis(job)}
    <div class="progress-wrap"><progress class="progress-track ${canCancel ? "is-active" : ""}" max="100" value="${progress}" aria-label="任务进度：${progress}%">${progress}%</progress><span class="progress-value">${progress}%</span><span class="progress-label">${statusBadge(job.status)} · ${escapeHtml(job.progress?.label || "等待状态")}</span></div>`;
  $("#back-to-history").addEventListener("click", () => { showView(state.detailReturnView || "reports"); loadJobs(); });
  $("#retry-failed")?.addEventListener("click", () => openRetryDialog(job, "failed_only"));
  $("#retry-full")?.addEventListener("click", () => openRetryDialog(job, "full"));
  $$('[data-related-job]').forEach((button) => button.addEventListener("click", () => openJob(button.dataset.relatedJob)));
  $("#cancel-job")?.addEventListener("click", async () => {
    if (!confirm("确定停止这个任务吗？已生成的日志和Checkpoint会保留。")) return;
    await api(`/api/jobs/${job.id}/cancel`, { method: "POST", body: "{}" });
    toast("停止请求已发送");
    await refreshJob();
  });
}

function openRetryDialog(job, scope) {
  state.retryJob = job;
  state.retryScope = scope;
  const dialog = $("#retry-dialog");
  const failures = job.retry?.failedItems || [];
  const selectedSessions = (job.retry?.selectableSessions || []).filter((item) => state.selectedBatchSessions.has(item.retryKey));
  $("#retry-dialog-title").textContent = scope === "failed_only" ? "仅重跑失败项" : scope === "selected_sessions" ? "重跑指定 Session" : "完整重跑任务";
  $("#retry-dialog-description").textContent = scope === "failed_only"
    ? `将创建新的 Attempt，仅执行 ${failures.length} 个失败项。成功项、旧日志和失败摘要全部保留。`
    : scope === "selected_sessions"
      ? `将创建新的 Attempt，重跑已选择的 ${selectedSessions.length} 个 Session，以及这些 CSV 行中的全部未命中 GT。旧报告保持不变。`
    : "将复制原始输入并创建新的 Attempt，重新执行整个任务。旧任务不会被修改。";
  $("#retry-selection-preview").innerHTML = scope === "failed_only"
    ? failures.map((item) => `<label class="retry-item"><input type="checkbox" name="retry-item" value="${escapeHtml(item.retryKey)}" checked><span><strong>${escapeHtml(item.sessionId || "未知Session")}</strong><b>${escapeHtml(item.criterionId || item.stage || "准备阶段")}</b><small>${escapeHtml(item.error || "失败")}</small></span></label>`).join("")
    : scope === "selected_sessions"
      ? selectedSessions.map((item) => `<div><strong>Session ${escapeHtml(item.sessionId)}</strong><span>${escapeHtml(item.rowNumbers?.length ? `CSV 行 ${item.rowNumbers.join("、")}` : "按Session匹配")}</span><small>重跑该 Session 所选 CSV 行的全部未命中 GT</small></div>`).join("")
    : `<div><strong>全部输入</strong><span>${job.type === "csv" ? "整个CSV批次" : `Session ${escapeHtml(job.inputSummary.sessionId)}`}</span><small>重新执行拉取检查、准备和全部GT归因；完整Trace仍优先复用缓存。</small></div>`;
  $("#retry-max-rounds").value = job.inputSummary?.maxRounds || 20;
  $("#retry-concurrency-field").hidden = job.type !== "csv";
  $("#retry-concurrency").value = job.inputSummary?.concurrency || 1;
  $("#retry-reason").value = "";
  setFormError($("#retry-errors"), "");
  dialog.showModal();
}

async function submitRetry(event) {
  event.preventDefault();
  const job = state.retryJob;
  if (!job || !state.retryScope) return;
  const errorBox = $("#retry-errors");
  setFormError(errorBox, "");
  const submit = $("#retry-submit");
  submit.disabled = true;
  submit.textContent = "正在创建 Attempt…";
  try {
    const { job: retryJob } = await api(`/api/jobs/${job.id}/retry`, {
      method: "POST",
      body: JSON.stringify({
        scope: state.retryScope,
        maxRounds: $("#retry-max-rounds").value,
        concurrency: job.type === "csv" ? $("#retry-concurrency").value : undefined,
        mode: job.inputSummary?.mode || "live",
        reason: $("#retry-reason").value,
        selectedFailureKeys: state.retryScope === "failed_only" ? $$('input[name="retry-item"]:checked').map((item) => item.value) : undefined,
        selectedSessionKeys: state.retryScope === "selected_sessions" ? [...state.selectedBatchSessions] : undefined,
      }),
    });
    $("#retry-dialog").close();
    toast(`Attempt ${retryJob.lineage?.attempt || ""} 已创建，旧任务保持不变`);
    await loadJobs();
    await openJob(retryJob.id);
  } catch (error) { setFormError(errorBox, error.message); }
  finally { submit.disabled = false; submit.textContent = "创建新 Attempt"; }
}

function preferredArtifact(job, artifacts) {
  const hasFailures = ["failed", "completed_with_failures"].includes(job.status);
  if (hasFailures) return artifacts.find((item) => item.name === "failure-summary.md") || artifacts.find((item) => item.name === "web-failure-summary.md") || artifacts.find((item) => item.name === "rca-report.md") || artifacts.find((item) => item.name === "agent-run-summary.md") || artifacts[0];
  return artifacts.find((item) => item.name === "rca-report.md") || artifacts.find((item) => item.name === "workflow-summary.md") || artifacts.find((item) => item.name === "agent-run-summary.md") || artifacts.find((item) => item.name === "agent-run.md") || artifacts[0];
}

function artifactShortLabel(item) {
  return ({
    "rca-report.md": "RCA 报告",
    "failure-summary.md": "失败摘要",
    "agent-run-summary.md": "执行摘要",
    "agent-run.md": "Agent 日志",
    "validation.json": "校验结果",
    "case.json": "输入快照",
    "workflow-summary.md": "批次摘要",
    "web-failure-summary.md": "Web 失败诊断",
    "web-job.jsonl": "Web 运行日志",
  })[item.name] || item.name;
}

function renderArtifactTabs(job, artifacts = []) {
  const importantNames = new Set(["web-failure-summary.md", "web-job.jsonl", "rca-report.md", "failure-summary.md", "agent-run-summary.md", "agent-run.md", "validation.json", "case.json", "workflow-summary.md"]);
  const important = artifacts.filter((item) => importantNames.has(item.name));
  $("#artifact-tabs").innerHTML = important.length
    ? important.map((item) => `<button class="artifact-tab ${state.activeArtifact === item.path ? "active" : ""}" data-artifact="${escapeHtml(item.path)}">${escapeHtml(artifactShortLabel(item))}</button>`).join("")
    : `<span class="progress-label">当前 GT 暂无可展示产物</span>`;
  $$('[data-artifact]').forEach((tab) => tab.addEventListener("click", () => loadArtifact(job.id, tab.dataset.artifact)));
  return important;
}

function renderSessionState(session) {
  const issue = session?.issue;
  const row = sessionRowLabel(session || {});
  if (issue) {
    const source = issue.kind === "source_run_failed";
    const title = source ? "上游评测无有效产物" : "Session 处理失败";
    const tone = source ? "source" : "failure";
    $("#report-context").innerHTML = `<nav class="breadcrumbs" aria-label="当前位置"><span>${escapeHtml(sessionLabel(session))}</span><svg><use href="#i-chevron"/></svg><strong>${escapeHtml(row)}</strong></nav><div class="report-context-title"><div><p class="kicker">SESSION STATUS · ${escapeHtml(row)}</p><h2>${title}</h2></div>${statusBadge(session.status)}</div>`;
    $("#artifact-tabs").innerHTML = `<span class="progress-label">当前 Session 没有 RCA 报告</span>`;
    $("#artifact-content").innerHTML = `<section class="session-diagnostic ${tone}">
      <div class="session-diagnostic-title"><span>${icon(source ? "session" : "stop")}</span><div><small>${escapeHtml(stageNames[issue.stage] || issue.stage || "未知阶段")}${issue.code ? ` · ${escapeHtml(issue.code)}` : ""}</small><h3>${escapeHtml(issue.label || title)}</h3></div></div>
      <dl><div><dt>CSV位置</dt><dd>${escapeHtml(row)}</dd></div><div><dt>失败阶段</dt><dd>${escapeHtml(stageNames[issue.stage] || issue.stage || "未知阶段")}</dd></div>${issue.code ? `<div><dt>错误码</dt><dd><code>${escapeHtml(issue.code)}</code></dd></div>` : ""}</dl>
      <div class="session-diagnostic-block"><strong>${source ? "缺失条件" : "失败原因"}</strong><p>${escapeHtml(issue.detail || "没有可用的错误详情。")}</p></div>
      <div class="session-diagnostic-block advice"><strong>处理建议</strong><p>${escapeHtml(issue.remediation || "修复后仅重跑该Session。")}</p></div>
    </section>`;
    return [];
  }
  $("#report-context").innerHTML = `<nav class="breadcrumbs" aria-label="当前位置"><span>${escapeHtml(sessionLabel(session))}</span><svg><use href="#i-chevron"/></svg><strong>${escapeHtml(row)}</strong></nav><div class="report-context-title"><div><p class="kicker">SESSION STATUS · ${escapeHtml(row)}</p><h2>等待处理</h2></div>${statusBadge(session?.status || "queued")}</div>`;
  $("#artifact-tabs").innerHTML = `<span class="progress-label">尚未进入 Trace RCA</span>`;
  $("#artifact-content").innerHTML = `<div class="empty-state">${icon("session")}<h3>等待调度</h3><p>${escapeHtml(row)} 已进入本批次执行计划，开始处理后将在这里显示GT、日志和报告。</p></div>`;
  return [];
}

function findReportSelection(job) {
  const tree = job.reportTree || { sessions: [], globalArtifacts: [] };
  if (state.activeCriterionKey === "__batch__") return { tree, session: null, criterion: null };
  let session = tree.sessions.find((item) => item.key === state.activeSessionKey);
  if (!session) session = tree.sessions.find((item) => item.criteria.length) || tree.sessions[0] || null;
  if (session) state.activeSessionKey = session.key;
  let criterion = session?.criteria.find((item) => item.key === state.activeCriterionKey);
  if (!criterion) criterion = session?.criteria[0] || null;
  if (criterion) state.activeCriterionKey = criterion.key;
  return { tree, session, criterion };
}

function renderReportWorkspace(job) {
  const { tree, session, criterion } = findReportSelection(job);
  $("#report-tree-header").innerHTML = `<p class="kicker">REPORT DIRECTORY</p><h2>批次报告</h2><p>${formatTime(tree.batch?.createdAt || job.createdAt)} · ${tree.counts?.startedRows ?? tree.counts?.sessions ?? 0}/${tree.counts?.nonFullScoreRows ?? tree.counts?.sessions ?? 0} 已进入处理 · ${tree.counts?.criteria || 0} GT</p>`;
  $("#report-tree-navigation").innerHTML = tree.sessions.length ? tree.sessions.map((entry) => {
    const expanded = entry.key === session?.key;
    return `<section class="session-node ${expanded ? "active" : ""}">
      <button class="session-button" data-session-key="${escapeHtml(entry.key)}" aria-expanded="${expanded}">
        <span class="session-node-icon">${icon("session")}</span><span><strong>${entry.sessionId ? `Session ${escapeHtml(entry.sessionId)}` : `CSV 行 ${escapeHtml(entry.rowNumbers?.[0] || entry.key)}`}</strong><small>${escapeHtml(sessionRowLabel(entry))} · ${entry.issue ? "源任务没有可归因结果" : `${entry.counts.criteria} 个 GT · ${entry.counts.completed} 完成 · ${entry.counts.failed} 失败`}</small></span>${statusBadge(entry.status)}${icon("chevron")}
      </button>
      <div class="criterion-list" ${expanded ? "" : "hidden"}>${entry.criteria.length ? entry.criteria.map((gt) => `<button class="criterion-button ${gt.key === criterion?.key ? "active" : ""}" data-session-key="${escapeHtml(entry.key)}" data-criterion-key="${escapeHtml(gt.key)}" aria-current="${gt.key === criterion?.key ? "page" : "false"}"><span class="criterion-marker"></span><span><strong>${escapeHtml(gt.criterionId)}</strong><small>${escapeHtml(stageNames[gt.stage] || gt.stage || (gt.status === "completed" ? "报告已生成" : "等待产物"))}</small></span>${statusBadge(gt.status)}</button>`).join("") : entry.issue ? `<div class="source-run-state" role="status"><strong>${escapeHtml(entry.issue.label || "源任务未成功运行")}</strong><p>${escapeHtml(entry.issue.detail || "没有可用于Trace归因的Session和评测结果。")}</p></div>` : `<p class="tree-empty">暂无 GT 归因项</p>`}</div>
    </section>`;
  }).join("") : `<div class="tree-empty"><strong>等待 Session</strong><p>Trace 拉取并解析评分后会显示 Session 与 GT。</p></div>`;
  $$('[data-session-key]').filter((button) => !button.dataset.criterionKey).forEach((button) => button.addEventListener("click", () => {
    state.activeSessionKey = button.dataset.sessionKey;
    state.activeCriterionKey = null;
    state.activeArtifact = null;
    renderReportWorkspace(job);
    renderBatchSessionOverview(job);
    renderEvents(job.type === "csv" ? sessionEvents(job, findReportSelection(job).session) : [...(job.webEvents || []), ...(job.events || [])]);
    const selected = findReportSelection(job).criterion;
    if (selected?.preferredArtifact) loadArtifact(job.id, selected.preferredArtifact.path);
  }));
  $$('[data-criterion-key]').forEach((button) => button.addEventListener("click", () => {
    state.activeSessionKey = button.dataset.sessionKey;
    state.activeCriterionKey = button.dataset.criterionKey;
    state.activeArtifact = null;
    renderReportWorkspace(job);
    renderBatchSessionOverview(job);
    renderEvents(job.type === "csv" ? sessionEvents(job, findReportSelection(job).session) : [...(job.webEvents || []), ...(job.events || [])]);
    const selected = findReportSelection(job).criterion;
    if (selected?.preferredArtifact) loadArtifact(job.id, selected.preferredArtifact.path);
  }));

  $("#batch-artifacts").innerHTML = tree.globalArtifacts?.length ? `<div class="batch-artifact-title">批次级文件</div>${tree.globalArtifacts.map((artifact) => `<button class="batch-artifact-button" data-batch-artifact="${escapeHtml(artifact.path)}">${icon("file")}<span>${escapeHtml(artifactShortLabel(artifact))}</span></button>`).join("")}` : "";
  $$('[data-batch-artifact]').forEach((button) => button.addEventListener("click", () => {
    state.activeSessionKey = null;
    state.activeCriterionKey = "__batch__";
    state.activeArtifact = button.dataset.batchArtifact;
    $("#report-context").innerHTML = `<nav class="breadcrumbs" aria-label="当前位置"><span>批次 ${formatTime(tree.batch.createdAt)}</span><svg><use href="#i-chevron"/></svg><strong>批次级文件</strong></nav><h2>批次运行与汇总</h2>`;
    renderArtifactTabs(job, tree.globalArtifacts);
    loadArtifact(job.id, button.dataset.batchArtifact);
  }));

  if (criterion) {
    const evidenceWarning = criterion.status === "completed_with_evidence_gaps"
      ? `<p class="evidence-gap-warning" role="status">本报告基于可见Trace完成，但存在局部Tool输出缺口；请在“Trace完整性与证据边界”中查看具体Span、字段和补拉错误。</p>`
      : "";
    $("#report-context").innerHTML = `<nav class="breadcrumbs" aria-label="当前位置"><span>批次 ${formatTime(tree.batch.createdAt)}</span><svg><use href="#i-chevron"/></svg><span>Session ${escapeHtml(session.sessionId || session.key)}</span><svg><use href="#i-chevron"/></svg><span>${escapeHtml(sessionRowLabel(session))}</span><svg><use href="#i-chevron"/></svg><strong>${escapeHtml(criterion.criterionId)}</strong></nav><div class="report-context-title"><div><p class="kicker">GT ROOT CAUSE REPORT · ${escapeHtml(sessionRowLabel(session))}</p><h2>${escapeHtml(criterion.criterionId)}</h2></div>${statusBadge(criterion.status)}</div>${evidenceWarning}${criterion.error ? `<p class="criterion-error" role="alert">${escapeHtml(criterion.error)}</p>` : ""}`;
    return renderArtifactTabs(job, criterion.artifacts);
  }
  if (session && state.activeCriterionKey !== "__batch__") return renderSessionState(session);
  $("#report-context").innerHTML = state.activeCriterionKey === "__batch__"
    ? `<nav class="breadcrumbs" aria-label="当前位置"><span>批次 ${formatTime(tree.batch?.createdAt)}</span><svg><use href="#i-chevron"/></svg><strong>批次级文件</strong></nav><h2>批次运行与汇总</h2>`
    : `<nav class="breadcrumbs" aria-label="当前位置"><span>批次 ${formatTime(tree.batch?.createdAt)}</span></nav><h2>等待报告目录</h2>`;
  return state.activeCriterionKey === "__batch__" ? renderArtifactTabs(job, tree.globalArtifacts || []) : [];
}

function simpleMarkdown(source) {
  const escaped = escapeHtml(source);
  const lines = escaped.split("\n");
  let html = "";
  let inCode = false;
  let inList = false;
  let inTable = false;
  for (let line of lines) {
    if (line.startsWith("```")) {
      if (inList) { html += "</ul>"; inList = false; }
      html += inCode ? "</code></pre>" : "<pre><code>";
      inCode = !inCode;
      continue;
    }
    if (inCode) { html += `${line}\n`; continue; }
    if (/^\|.*\|$/.test(line)) {
      if (/^\|[-: |]+\|$/.test(line)) continue;
      const cells = line.slice(1, -1).split("|").map((cell) => `<td>${inlineMarkdown(cell.trim())}</td>`).join("");
      if (!inTable) { html += "<table><tbody>"; inTable = true; }
      html += `<tr>${cells}</tr>`;
      continue;
    }
    if (inTable) { html += "</tbody></table>"; inTable = false; }
    const heading = line.match(/^(#{1,3})\s+(.+)/);
    if (heading) { if (inList) { html += "</ul>"; inList = false; } const level = heading[1].length; html += `<h${level}>${inlineMarkdown(heading[2])}</h${level}>`; continue; }
    if (/^[-*]\s+/.test(line)) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    if (line.startsWith("&gt; ")) { html += `<blockquote>${inlineMarkdown(line.slice(5))}</blockquote>`; continue; }
    if (line.trim()) html += `<p>${inlineMarkdown(line)}</p>`;
  }
  if (inList) html += "</ul>";
  if (inTable) html += "</tbody></table>";
  if (inCode) html += "</code></pre>";
  return html;
}

function inlineMarkdown(value) {
  return value.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

async function loadArtifact(jobId, artifactPath) {
  state.activeArtifact = artifactPath;
  $$("[data-artifact]").forEach((tab) => tab.classList.toggle("active", tab.dataset.artifact === artifactPath));
  $("#artifact-content").innerHTML = `<div class="empty-state"><h3>正在读取产物…</h3></div>`;
  try {
    const { content } = await api(`/api/jobs/${jobId}/artifact?path=${encodeURIComponent(artifactPath)}`);
    if (artifactPath.endsWith(".md")) $("#artifact-content").innerHTML = `<div class="markdown-view">${simpleMarkdown(content)}</div>`;
    else $("#artifact-content").innerHTML = `<pre>${escapeHtml(content)}</pre>`;
  } catch (error) { $("#artifact-content").innerHTML = `<div class="form-errors">${escapeHtml(error.message)}</div>`; }
}

async function refreshJob() {
  if (!state.activeJobId) return;
  try {
    const { job } = await api(`/api/jobs/${state.activeJobId}`);
    state.currentJob = job;
    renderDetailHeader(job);
    const timelineEvents = (job.events || []).length ? [...(job.webEvents || []), ...(job.events || [])] : (job.webEvents || []);
    renderBatchSessionOverview(job);
    const selectedSession = findReportSelection(job).session;
    renderEvents(job.type === "csv" && selectedSession ? sessionEvents(job, selectedSession) : timelineEvents);
    const important = renderReportWorkspace(job);
    const selectedExists = important.some((item) => item.path === state.activeArtifact);
    const becameFailure = ["failed", "completed_with_failures"].includes(job.status) && !["failed", "completed_with_failures"].includes(state.activeJobStatus);
    if (!selectedExists || becameFailure) {
      const { criterion, tree, session } = findReportSelection(job);
      const preferred = criterion?.preferredArtifact || preferredArtifact(job, important)
        || (state.activeCriterionKey === "__batch__" || !session ? preferredArtifact(job, tree.globalArtifacts || []) : null);
      if (preferred) await loadArtifact(job.id, preferred.path);
      else if (!session) $("#artifact-content").innerHTML = `<div class="empty-state">${icon("file")}<h3>等待生成产物</h3><p>报告会按 Session 与 GT 自动归档。</p></div>`;
    }
    state.activeJobStatus = job.status;
    if (!["queued", "running"].includes(job.status)) {
      clearInterval(state.poll);
      await loadJobs();
    }
  } catch (error) { toast(error.message); }
}

async function openJob(id, origin = "reports") {
  state.activeJobId = id;
  state.activeArtifact = null;
  state.activeSessionKey = null;
  state.activeCriterionKey = null;
  state.batchSessionQuery = "";
  state.batchSessionStatus = "all";
  state.selectedBatchSessions = new Set();
  state.activeJobStatus = null;
  state.detailReturnView = origin;
  showView("detail");
  state.activeJobId = id;
  await refreshJob();
  clearInterval(state.poll);
  state.poll = setInterval(refreshJob, 1800);
}

async function initialize() {
  $$("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  $("#session-form").addEventListener("submit", submitSession);
  $("#csv-form").addEventListener("submit", submitCsv);
  $("#csv-file").addEventListener("change", (event) => chooseCsv(event.target.files[0]));
  $("#retry-form").addEventListener("submit", submitRetry);
  $("#retry-cancel").addEventListener("click", () => $("#retry-dialog").close());
  $("#fail-fast").addEventListener("change", (event) => {
    const concurrency = $("#csv-concurrency");
    if (event.currentTarget.checked) concurrency.value = "1";
    concurrency.disabled = event.currentTarget.checked;
  });
  $("#history-search").addEventListener("input", () => { renderHistory(); bindJobRows(); });
  $("#report-search").addEventListener("input", () => { renderReports(); bindJobRows(); });
  $("#batch-session-search").addEventListener("input", (event) => { state.batchSessionQuery = event.target.value; if (state.currentJob) renderBatchSessionOverview(state.currentJob); });
  $("#batch-session-status").addEventListener("change", (event) => { state.batchSessionStatus = event.target.value; if (state.currentJob) renderBatchSessionOverview(state.currentJob); });
  $("#batch-select-visible").addEventListener("click", () => {
    const job = state.currentJob;
    if (!job) return;
    const selectable = new Set((job.retry?.selectableSessions || []).map((item) => item.retryKey));
    const query = state.batchSessionQuery.trim().toLowerCase();
    const status = state.batchSessionStatus;
    for (const session of job.reportTree?.sessions || []) {
      const current = normalizedSessionStatus(session);
      const label = `${sessionLabel(session)} ${(session.rowNumbers || []).join(" ")}`.toLowerCase();
      const shown = (!query || label.includes(query)) && (status === "all" || current === status || (status === "failed" && session.counts?.failed > 0));
      if (shown && selectable.has(session.retryKey)) state.selectedBatchSessions.add(session.retryKey);
    }
    renderBatchSessionOverview(job);
  });
  $("#batch-clear-selection").addEventListener("click", () => {
    state.selectedBatchSessions.clear();
    if (state.currentJob) renderBatchSessionOverview(state.currentJob);
  });
  $("#batch-retry-selected").addEventListener("click", () => {
    if (!state.currentJob || !state.selectedBatchSessions.size) return;
    openRetryDialog(state.currentJob, "selected_sessions");
  });
  const drop = $("#drop-zone");
  ["dragenter", "dragover"].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove("dragging"); }));
  drop.addEventListener("drop", (event) => chooseCsv(event.dataTransfer.files[0]));

  try {
    const health = await api("/api/health");
    $("#health-dot").classList.toggle("ok", health.ok);
    $("#health-title").textContent = health.ok
      ? health.modelConfigured ? "服务正常" : "模型待配置"
      : "服务异常";
  } catch { $("#health-title").textContent = "无法连接服务"; }
  try { await loadJobs(); } catch (error) { toast(error.message); }
}

initialize();
