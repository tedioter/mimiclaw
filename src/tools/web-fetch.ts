import { z } from "zod";
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import * as cheerio from "cheerio";
import { ToolError, errorMessage } from "../types/errors.js";
import { Tool } from "./base.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const DNS_RETRIES = 3;
const REQUEST_RETRIES = 2;
const RETRY_DELAY_MS = 250;

const schema = z.object({
  url: z.string()
});

type ResolvedAddress = {
  address: string;
  family: number;
};

type ValidatedPublicUrl = {
  url: URL;
  addresses: ResolvedAddress[];
};

type ResponseBody = ReadableStream<Uint8Array> | IncomingMessage | null;

type WebResponse = {
  status: number;
  headers: Headers;
  url: string;
  body: ResponseBody;
};

function isPrivateIpv4(address: string): boolean {
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 18) ||
    (a === 198 && b === 19) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** 将 IPv6 文本展开为八组十六进制数字，兼容带 IPv4 尾段的写法。 */
function parseIpv6Groups(address: string): number[] | undefined {
  let normalized = address.toLowerCase();
  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex >= 0) {
    normalized = normalized.slice(0, zoneIndex);
  }
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    const ipv4 = normalized.slice(separator + 1);
    if (separator < 0 || !net.isIPv4(ipv4)) {
      return undefined;
    }
    const octets = ipv4.split(".").map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    normalized = `${normalized.slice(0, separator)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const sections = normalized.split("::");
  if (sections.length > 2) {
    return undefined;
  }
  const parseSection = (section: string): number[] | undefined => {
    if (!section) {
      return [];
    }
    const groups = section.split(":").map((part) => {
      if (!/^[0-9a-f]{1,4}$/.test(part)) {
        return undefined;
      }
      return Number.parseInt(part, 16);
    });
    return groups.every((group): group is number => group !== undefined) ? groups : undefined;
  };
  const left = parseSection(sections[0] ?? "");
  const right = sections.length === 2 ? parseSection(sections[1] ?? "") : [];
  if (!left || !right) {
    return undefined;
  }
  const missing = 8 - left.length - right.length;
  if (sections.length === 1 ? missing !== 0 : missing < 1) {
    return undefined;
  }
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    return isPrivateIpv4(address);
  }
  if (!net.isIPv6(address)) {
    return false;
  }
  const groups = parseIpv6Groups(address);
  if (!groups) {
    return false;
  }
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const compatible = groups.slice(0, 6).every((group) => group === 0);
  if (mapped || compatible) {
    const group6 = groups[6] ?? 0;
    const group7 = groups[7] ?? 0;
    const ipv4 = [group6 >> 8, group6 & 0xff, group7 >> 8, group7 & 0xff].join(".");
    return isPrivateIpv4(ipv4);
  }
  const isUnspecified = groups.every((group) => group === 0);
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  if (isUnspecified || isLoopback) {
    return true;
  }
  const first = groups[0] ?? 0;
  return (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "EPIPE" ||
    code === "ECONNABORTED"
  );
}

async function resolvePublicUrl(rawUrl: string): Promise<ValidatedPublicUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ToolError("只支持公开的 HTTP 或 HTTPS URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new ToolError("只支持公开的 HTTP 或 HTTPS URL");
  }
  if (url.username || url.password) {
    throw new ToolError("网页 URL 不能包含用户名或密码");
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await dns.lookup(url.hostname, { all: true });
  } catch (error) {
    throw new ToolError("无法解析网页域名", { cause: error });
  }
  if (!addresses.length || addresses.some((item) => isPrivateIp(item.address))) {
    throw new ToolError("出于安全原因，不能访问本机或内网地址");
  }
  return { url, addresses };
}

async function resolvePublicUrlWithRetry(rawUrl: string): Promise<ValidatedPublicUrl> {
  let lastError: unknown;
  for (let attempt = 0; attempt < DNS_RETRIES; attempt++) {
    try {
      return await resolvePublicUrl(rawUrl);
    } catch (error) {
      if (error instanceof ToolError && error.message !== "无法解析网页域名") {
        throw error;
      }
      lastError = error;
      if (attempt < DNS_RETRIES - 1) {
        await delay(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }
  throw lastError;
}

export async function validatePublicUrl(rawUrl: string): Promise<URL> {
  return (await resolvePublicUrl(rawUrl)).url;
}

function isIpLiteral(hostname: string): boolean {
  return net.isIP(hostname.replace(/^\[|\]$/g, "")) !== 0;
}

function toHeaders(headers: http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      result.set(name, value.join(", "));
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

function pinnedLookup(address: ResolvedAddress): NonNullable<http.RequestOptions["lookup"]> {
  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(null, [{ address: address.address, family: address.family }]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

function requestPinnedOnce(
  target: ValidatedPublicUrl,
  address: ResolvedAddress,
  signal: AbortSignal
): Promise<WebResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("网页请求已取消"));
      return;
    }
    const { url } = target;
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { "user-agent": "Mimi-Agent/0.1 (+local personal assistant)" },
        lookup: pinnedLookup(address),
        ...(url.protocol === "https:" ? { servername: url.hostname } : {})
      },
      (response) => {
        signal.removeEventListener("abort", abort);
        resolve({
          status: response.statusCode ?? 0,
          headers: toHeaders(response.headers),
          url: url.toString(),
          body: response
        });
      }
    );
    const abort = () => {
      request.destroy(signal.reason instanceof Error ? signal.reason : new Error("网页请求已取消"));
    };
    signal.addEventListener("abort", abort, { once: true });
    request.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    request.end();
  });
}

async function requestPinned(
  target: ValidatedPublicUrl,
  signal: AbortSignal
): Promise<WebResponse> {
  let lastError: unknown;
  for (const address of target.addresses) {
    try {
      return await requestPinnedOnce(target, address, signal);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError ?? new Error("网页请求没有可用的公网地址");
}

async function requestPublicUrl(
  target: ValidatedPublicUrl,
  signal: AbortSignal
): Promise<WebResponse> {
  if (isIpLiteral(target.url.hostname)) {
    return fetch(target.url, {
      redirect: "manual",
      signal,
      headers: { "User-Agent": "Mimi-Agent/0.1 (+local personal assistant)" }
    });
  }
  return requestPinned(target, signal);
}

async function requestPublicUrlWithRetry(
  target: ValidatedPublicUrl,
  timeoutSeconds: number
): Promise<WebResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
    const signal = AbortSignal.timeout(Math.ceil(timeoutSeconds * 1000));
    try {
      return await requestPublicUrl(target, signal);
    } catch (error) {
      lastError = error;
      if (signal.aborted && !isRetryableNetworkError(error)) {
        throw new ToolError(`网页请求超时（${timeoutSeconds} 秒）`, { cause: error });
      }
      if (attempt < REQUEST_RETRIES && isRetryableNetworkError(error)) {
        await delay(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      if (signal.aborted) {
        throw new ToolError(`网页请求超时（${timeoutSeconds} 秒）`, { cause: error });
      }
      throw new ToolError(`网页请求失败：${errorMessage(error)}`, { cause: error });
    }
  }
  throw new ToolError(`网页请求失败：${errorMessage(lastError)}`, { cause: lastError });
}

function isNodeResponseBody(body: ResponseBody): body is IncomingMessage {
  return body !== null && typeof (body as IncomingMessage).destroy === "function";
}

async function cancelResponseBody(response: WebResponse): Promise<void> {
  if (isNodeResponseBody(response.body)) {
    response.body.destroy();
    return;
  }
  try {
    await response.body?.cancel();
  } catch {
    /* 清理失败不覆盖原始响应错误。 */
  }
}

async function readNodeResponseBody(body: IncomingMessage, limit: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let stopped = false;
  try {
    for await (const value of body) {
      const chunk = decoder.decode(typeof value === "string" ? Buffer.from(value) : value, {
        stream: true
      });
      const remaining = limit + 1 - text.length;
      if (remaining <= 0) {
        stopped = true;
        break;
      }
      if (chunk.length >= remaining) {
        text += chunk.slice(0, remaining);
        stopped = true;
        break;
      }
      text += chunk;
    }
    if (!stopped) {
      text += decoder.decode();
    }
  } finally {
    if (stopped) {
      body.destroy();
    }
  }
  return text;
}

async function readResponseBody(response: WebResponse, maxChars: number): Promise<string> {
  if (!response.body) {
    return "";
  }
  const limit = Math.max(0, Math.trunc(maxChars));
  if (isNodeResponseBody(response.body)) {
    return readNodeResponseBody(response.body, limit);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        completed = true;
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      const remaining = limit + 1 - text.length;
      if (remaining <= 0) {
        break;
      }
      if (chunk.length >= remaining) {
        text += chunk.slice(0, remaining);
        break;
      }
      text += chunk;
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
  return text;
}

const HTML_BLOCK_SELECTORS = "p, div, section, article, li, h1, h2, h3, h4, tr";

export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg").remove();
  $("br").replaceWith("\n");
  $(HTML_BLOCK_SELECTORS).append("\n");
  const text = $("body").length > 0 ? $("body").text() : $.root().text();
  return text
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export class WebFetchTool extends Tool {
  readonly name = "web_fetch";
  readonly description = "发起 HTTP/HTTPS 请求并返回可读文本；不支持本机和内网地址";
  readonly schema = schema;

  constructor(
    private readonly maxChars: number,
    private readonly timeoutSeconds: number
  ) {
    super();
    if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
      throw new ToolError("网页正文字符上限必须是正整数");
    }
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new ToolError("网页请求超时时间必须是大于 0 的有限数字");
    }
  }

  async execute(arguments_: Record<string, unknown>): Promise<string> {
    const args = schema.parse(arguments_);
    let target = await resolvePublicUrlWithRetry(args.url);
    let response: WebResponse | undefined;
    let redirects = 0;
    while (true) {
      response = await requestPublicUrlWithRetry(target, this.timeoutSeconds);
      if (!REDIRECT_STATUSES.has(response.status)) {
        break;
      }
      const location = response.headers.get("location");
      if (!location) {
        break;
      }
      if (redirects >= MAX_REDIRECTS) {
        await cancelResponseBody(response);
        throw new ToolError(`网页重定向次数超过上限（最多 ${MAX_REDIRECTS} 次）`);
      }
      await cancelResponseBody(response);
      redirects++;
      target = await resolvePublicUrlWithRetry(new URL(location, target.url).toString());
    }
    if (!response) {
      throw new ToolError("HTTP 请求失败：没有响应");
    }
    const contentTypeHeader = response.headers.get("content-type") ?? "text/plain";
    const contentType = (contentTypeHeader.split(";", 1)[0] ?? "text/plain").trim().toLowerCase();
    const supported =
      ["text/html", "application/xhtml+xml"].includes(contentType) ||
      contentType.startsWith("text/") ||
      ["application/json", "application/xml"].includes(contentType);
    if (!supported) {
      await cancelResponseBody(response);
      throw new ToolError(`不支持返回类型：${contentType}`);
    }
    const raw = await readResponseBody(response, this.maxChars);
    let text: string;
    if (["text/html", "application/xhtml+xml"].includes(contentType)) {
      text = htmlToText(raw);
    } else {
      text = raw.trim();
    }
    if (text.length > this.maxChars) {
      text = `${text.slice(0, this.maxChars)}\n\n[内容已截断，最多读取 ${this.maxChars} 字符]`;
    }
    return `URL：${response.url || target.url}\nStatus：${response.status}\nContent-Type：${contentType}\n\n${text}`;
  }
}
