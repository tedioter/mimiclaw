import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "../src/types/errors.js";
import { htmlToText, validatePublicUrl } from "../src/tools/web-fetch.js";
import { temporaryDirectory, testTool } from "./test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockDns(address: string, family: 4 | 6): void {
  // Node DNS 的 lookup 有多个重载，这里固定模拟 all: true 的返回形状。
  vi.spyOn(dns, "lookup").mockResolvedValue([{ address, family }] as never);
}

describe("网页地址安全校验", () => {
  it.each(["http://[::ffff:127.0.0.1]", "http://[0:0:0:0:0:ffff:0a00:1]"])(
    "拒绝 IPv4 映射私网地址 %s",
    async (url) => {
      mockDns(url.includes("0:0:0") ? "::ffff:10.0.0.1" : "::ffff:127.0.0.1", 6);
      await expect(validatePublicUrl(url)).rejects.toThrow("出于安全原因，不能访问本机或内网地址");
    }
  );

  it.each(["http://[::]", "http://[::1]"])("拒绝 IPv6 未指定地址和回环地址 %s", async (url) => {
    mockDns(url.endsWith("::1]") ? "::1" : "::", 6);
    await expect(validatePublicUrl(url)).rejects.toThrow("出于安全原因，不能访问本机或内网地址");
  });

  it.each(["http://100.64.0.1", "http://[ff02::1]", "http://[fec0::1]"])(
    "拒绝不可公开访问的保留地址 %s",
    async (url) => {
      const address = url.includes("100.64")
        ? "100.64.0.1"
        : url.includes("ff02")
          ? "ff02::1"
          : "fec0::1";
      mockDns(address, url.includes("[") ? 6 : 4);
      await expect(validatePublicUrl(url)).rejects.toThrow("出于安全原因，不能访问本机或内网地址");
    }
  );
});

describe("HTML 正文提取", () => {
  it("忽略 script/style 并保留可见文本", () => {
    const html =
      "<html><head><script>alert(1)</script><style>.x{color:red}</style></head>" +
      "<body><h1>标题</h1><p>Hello <b>world</b></p><noscript>fallback</noscript></body></html>";
    const text = htmlToText(html);
    expect(text).toContain("标题");
    expect(text).toContain("Hello world");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("fallback");
  });
});

describe("网页抓取限制", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY])("拒绝无效的正文上限 %s", (maxChars) => {
    const root = temporaryDirectory();
    expect(() => testTool("web_fetch", root, { maxWebChars: maxChars as number })).toThrow(
      "网页正文字符上限必须是正整数"
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0])("拒绝无效的请求超时 %s", (timeout) => {
    const root = temporaryDirectory();
    expect(() =>
      testTool("web_fetch", root, { webFetchTimeoutSeconds: timeout as number })
    ).toThrow("网页请求超时时间必须是大于 0 的有限数字");
  });

  it("DNS 解析短暂失败时会重试", async () => {
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockRejectedValueOnce(new Error("EAI_AGAIN"))
      .mockRejectedValueOnce(new Error("EAI_AGAIN"))
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" }
        })
      )
    );

    const result = await testTool("web_fetch", temporaryDirectory(), { maxWebChars: 100 }).execute({
      url: "https://93.184.216.34/page"
    });

    expect(result).toContain("ok");
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("重定向超过上限时返回明确错误", async () => {
    mockDns("93.184.216.34", 4);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://93.184.216.34/next" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      testTool("web_fetch", temporaryDirectory(), { maxWebChars: 100 }).execute({
        url: "https://93.184.216.34/start"
      })
    ).rejects.toThrow("网页重定向次数超过上限（最多 5 次）");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("达到正文上限后取消响应流而不是完整读取", async () => {
    mockDns("93.184.216.34", 4);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("超出限制的正文"));
      },
      cancel() {
        cancelled = true;
      }
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" }
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await testTool("web_fetch", temporaryDirectory(), { maxWebChars: 4 }).execute({
      url: "https://93.184.216.34/text"
    });

    expect(result).toContain("内容已截断，最多读取 4 字符");
    expect(cancelled).toBe(true);
  });

  it("不支持的响应类型在读取正文前报错", async () => {
    mockDns("93.184.216.34", 4);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("binary"));
        controller.close();
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/octet-stream" }
        })
      )
    );

    await expect(
      testTool("web_fetch", temporaryDirectory(), { maxWebChars: 100 }).execute({
        url: "https://93.184.216.34/file"
      })
    ).rejects.toThrow(ToolError);
  });
});
