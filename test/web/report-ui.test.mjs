import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexPath = new URL("../../src/web/public/index.html", import.meta.url);
const appPath = new URL("../../src/web/public/app.js", import.meta.url);
const stylesPath = new URL("../../src/web/public/styles.css", import.meta.url);
const logoMarkPath = new URL("../../src/web/public/assets/logo-mark.svg", import.meta.url);
const logoHorizontalPath = new URL("../../src/web/public/assets/logo-horizontal.svg", import.meta.url);
const logoDarkPath = new URL("../../src/web/public/assets/logo-mark-dark.svg", import.meta.url);
const faviconPath = new URL("../../src/web/public/assets/favicon.svg", import.meta.url);

test("Web shell uses the Trace RCA vector brand assets", async () => {
  const [html, css, logo, horizontal, dark, favicon] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(stylesPath, "utf8"),
    readFile(logoMarkPath, "utf8"),
    readFile(logoHorizontalPath, "utf8"),
    readFile(logoDarkPath, "utf8"),
    readFile(faviconPath, "utf8"),
  ]);
  assert.match(html, /rel="icon" href="\.\/assets\/favicon\.svg"/);
  assert.match(html, /class="brand-mark" src="\.\/assets\/logo-mark\.svg" alt=""/);
  assert.match(css, /\.brand-mark/);
  for (const asset of [logo, horizontal, dark, favicon]) {
    assert.match(asset, /<svg[^>]+viewBox=/);
    assert.doesNotMatch(asset, /<script|(?:href|src)=\"https?:\/\//i);
  }
});

test("Web report center exposes Batch -> Session -> GT navigation", async () => {
  const [html, app, css] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);
  assert.match(html, /data-view="reports">报告</);
  assert.match(html, /id="reports-view"/);
  assert.match(html, /id="report-tree-navigation"/);
  assert.match(html, /aria-label="Session 与 GT"/);
  assert.match(html, /id="report-context"/);
  assert.match(app, /job\.reportTree/);
  assert.match(app, /function renderReportWorkspace/);
  assert.match(app, /data-session-key/);
  assert.match(app, /data-criterion-key/);
  assert.match(css, /\.report-workspace/);
  assert.match(css, /\.session-node/);
  assert.match(css, /\.criterion-button/);
});

test("CSV batch detail exposes a batch-scoped Session workspace", async () => {
  const app = await readFile(appPath, "utf8");
  const html = await readFile(indexPath, "utf8");
  assert.match(html, /id="batch-session-overview"/);
  assert.match(html, /id="batch-session-grid"/);
  assert.match(html, /id="batch-session-status"/);
  assert.match(html, /id="batch-session-selection"/);
  assert.match(html, /id="batch-retry-selected"/);
  assert.match(app, /function renderBatchSessionOverview/);
  assert.match(app, /data-batch-select/);
  assert.match(app, /selected_sessions/);
  assert.doesNotMatch(app, /<button class="batch-session-card/);
  assert.match(app, /<article class="batch-session-card/);
  assert.match(app, /function sessionEvents/);
  assert.match(app, /仅展示当前批次/);
  assert.match(app, /function sessionRowLabel/);
  assert.match(app, /CSV 行/);
  assert.match(app, /已进入处理/);
  assert.match(app, /满分题不展示/);
  assert.match(app, /function renderSessionState/);
  assert.match(app, /当前 Session 没有 RCA 报告/);
  assert.match(app, /Session 处理失败/);
  assert.match(app, /上游评测无有效产物/);
});
