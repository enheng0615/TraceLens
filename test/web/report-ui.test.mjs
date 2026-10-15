import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexPath = new URL("../../src/web/public/index.html", import.meta.url);
const appPath = new URL("../../src/web/public/app.js", import.meta.url);
const stylesPath = new URL("../../src/web/public/styles.css", import.meta.url);
const brandStylesPath = new URL("../../src/web/public/tracelens.css", import.meta.url);
const logoPath = new URL("../../src/web/public/assets/tracelens-logo.png", import.meta.url);
const faviconPath = new URL("../../src/web/public/assets/tracelens-mark.svg", import.meta.url);

test("Web shell uses the supplied TraceLens logo and favicon", async () => {
  const [html, css, logo, favicon] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(brandStylesPath, "utf8"),
    readFile(logoPath),
    readFile(faviconPath, "utf8"),
  ]);
  assert.match(html, /<title>TraceLens<\/title>/);
  assert.match(html, /rel="icon" href="\.\/assets\/tracelens-mark\.svg"/);
  assert.match(html, /class="brand-logo" src="\.\/assets\/tracelens-logo\.png" alt="TraceLens"/);
  assert.match(css, /\.brand-logo/);
  assert.deepEqual([...logo.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.match(favicon, /<svg[^>]+viewBox=/);
  assert.doesNotMatch(favicon, /<script|(?:href|src)=\"https?:\/\//i);
});

test("Web report center exposes Batch -> Session -> GT navigation", async () => {
  const [html, app, css] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);
  assert.match(html, /data-view="reports"[^>]*>.*?报告</s);
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
  assert.match(app, /当前 Session 没有\$\{feedbackBatch \? "反馈分析" : " RCA"\}报告/);
  assert.match(app, /Session 处理失败/);
  assert.match(app, /上游评测无有效产物/);
  assert.match(app, /评测输入问题/);
});

test("Markdown code blocks keep high contrast and do not inherit inline-code chips", async () => {
  const [app, css] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);
  assert.match(app, /<pre><code>/);
  assert.match(css, /\.markdown-view pre \{[^}]*color: #242426;[^}]*background: #f7f7f9;/s);
  assert.match(css, /\.markdown-view pre code \{[^}]*padding: 0;[^}]*color: inherit;[^}]*background: transparent;/s);
  assert.match(css, /\.markdown-view code \{[^}]*background: #f1f1f3;/s);
});
