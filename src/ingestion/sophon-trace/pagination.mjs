import path from "node:path";
import { TraceIngestionError } from "./errors.mjs";

export async function fetchCursorPages({
  client,
  directory,
  itemKey,
  buildArgs,
  pageSize = 200,
  force = false,
  maxPages = 10_000,
}) {
  const pages = [];
  const items = [];
  const seenTokens = new Set();
  let token;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const filePath = path.join(
      directory,
      `page-${String(pageNumber).padStart(4, "0")}.json`,
    );
    const payload = await client.fetchJson(
      filePath,
      buildArgs({ pageSize, pageToken: token }),
      { force },
    );
    const data = payload?.data;
    if (!data || !Array.isArray(data[itemKey])) {
      throw new TraceIngestionError(
        `分页响应缺少 data.${itemKey} 数组`,
        { code: "INVALID_PAGE_RESPONSE", details: { filePath, itemKey } },
      );
    }

    items.push(...data[itemKey]);
    pages.push({
      filePath,
      itemCount: data[itemKey].length,
      hasMore: Boolean(data.hasMore),
      nextPageToken: data.nextPageToken ?? null,
    });

    if (!data.hasMore) return { items, pages, complete: true };

    const nextToken = data.nextPageToken;
    if (!nextToken || seenTokens.has(String(nextToken))) {
      throw new TraceIngestionError(
        "分页响应返回空或重复的 nextPageToken",
        {
          code: "INVALID_PAGE_TOKEN",
          details: { filePath, itemKey, nextPageToken: nextToken ?? null },
        },
      );
    }
    seenTokens.add(String(nextToken));
    token = String(nextToken);
  }

  throw new TraceIngestionError(`分页超过安全上限 ${maxPages}`, {
    code: "PAGE_LIMIT_EXCEEDED",
    details: { directory, itemKey, maxPages },
  });
}
