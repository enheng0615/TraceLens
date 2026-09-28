#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import {
  extractSessionId,
  SophonCliClient,
  SophonSessionCollector,
} from "../src/ingestion/sophon-trace/index.mjs";

function usage() {
  return `用法：
  node scripts/fetch-sophon-session.mjs --session-id <ID> [选项]
  node scripts/fetch-sophon-session.mjs --query-url <URL> [选项]

选项：
  --session-id <ID>       Sophon Session ID
  --query-url <URL>       包含 session_id/sessionId 的评测 URL
  --output-root <目录>    输出根目录（默认：data/raw/sophon-sessions）
  --tenant <名称>         sophon-cli tenant profile（默认：data）
  --agent-type <类型>     ida | aide_solo | aide_mix（默认：ida）
  --region <区域>         cn | sg（可选）
  --user-email <邮箱>     sophon-cli JWT 不可用时的只读身份降级（可选）
  --page-size <数量>      每页数量，1-200（默认：200）
  --padding-ms <毫秒>     Session 时间窗前后扩展（默认：300000）
  --timeout-ms <毫秒>     单次 sophon-cli 超时（默认：120000）
  --retries <次数>        网络类失败重试次数（默认：2）
  --force                 删除该 Session 旧目录并全量重拉
  --help                  显示帮助
`;
}

function parseArgs(argv) {
  const result = {};
  const valueOptions = new Set([
    "session-id",
    "query-url",
    "output-root",
    "tenant",
    "agent-type",
    "region",
    "user-email",
    "page-size",
    "padding-ms",
    "timeout-ms",
    "retries",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") result.help = true;
    else if (arg === "--force") result.force = true;
    else if (arg.startsWith("--") && valueOptions.has(arg.slice(2))) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} 缺少值`);
      }
      result[arg.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return result;
}

function positiveInteger(value, fallback, name, { allowZero = false } = {}) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${name} 必须为${allowZero ? "非负" : "正"}整数`);
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (Boolean(args["session-id"]) === Boolean(args["query-url"])) {
    throw new Error("必须且只能提供 --session-id 或 --query-url 其中之一");
  }

  const sessionId = args["session-id"] || extractSessionId(args["query-url"]);
  const outputRoot = path.resolve(
    args["output-root"] || "data/raw/sophon-sessions",
  );
  const client = new SophonCliClient({
    tenant: args.tenant || "data",
    region: args.region,
    userEmail: args["user-email"] || process.env.SOPHON_INGESTION_USER_EMAIL || process.env.SOPHON_OPERATOR_EMAIL,
    timeoutMs: positiveInteger(args["timeout-ms"], 120_000, "timeout-ms"),
    retries: positiveInteger(args.retries, 2, "retries", { allowZero: true }),
  });
  const collector = new SophonSessionCollector({ client, outputRoot });
  const result = await collector.collect({
    sessionId,
    agentType: args["agent-type"] || "ida",
    pageSize: positiveInteger(args["page-size"], 200, "page-size"),
    paddingMs: positiveInteger(args["padding-ms"], 300_000, "padding-ms", {
      allowZero: true,
    }),
    force: Boolean(args.force),
  });

  console.log(`\n采集状态: ${result.manifest.status}`);
  console.log(`输出目录: ${result.outputDirectory}`);
  console.log(`完整性报告: ${path.join(result.outputDirectory, "integrity-report.json")}`);
}

main().catch((error) => {
  console.error(`${error.code ? `[${error.code}] ` : ""}${error.message}`);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
});
