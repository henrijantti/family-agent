import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlText, privateAddress, webRead } from "../src/agent/web.js";

test("web_read refuses the server's own network and non-web addresses", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "100.123.81.124", "169.254.169.254", "192.168.1.1", "172.20.0.1", "0.0.0.0", "::1", "fd7a:115c:a1e0::1", "::ffff:127.0.0.1"]) assert.ok(privateAddress(ip), ip);
  for (const ip of ["1.1.1.1", "212.147.251.157", "2a00:1450:4026::1"]) assert.ok(!privateAddress(ip), ip);
  const never = (async () => {
    throw new Error("fetched");
  }) as unknown as typeof fetch;
  for (const url of ["http://127.0.0.1:18789/", "http://localhost/", "file:///etc/passwd", "https://user:pw@example.com/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "https://example.com:8443/", "http://box.tail1234.ts.net/"]) {
    await assert.rejects(webRead(url, 0, never), /public|only|login|valid/, url);
  }
});

test("web_read follows a redirect only to a public address and returns readable text", async () => {
  const pages: Record<string, Response> = {};
  const fake = (async (u: string) => pages[u] ?? new Response("nope", { status: 404 })) as unknown as typeof fetch;
  pages["http://1.1.1.1/a"] = new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
  await assert.rejects(webRead("http://1.1.1.1/a", 0, fake), /public/);
  pages["http://1.1.1.1/b"] = new Response(
    "<html><head><title>Ottelut &ndash; PKT</title><script>evil()</script></head><body><h1>Ottelut</h1><p>su 8.11. klo 15.00 Flames&nbsp;- PKT</p><a href=\"/match/1\">Ottelu</a></body></html>",
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
  const r = await webRead("http://1.1.1.1/b", 0, fake);
  assert.equal(r.title, "Ottelut – PKT");
  assert.equal(r.text, "Ottelut\nsu 8.11. klo 15.00 Flames - PKT\nOttelu (/match/1)");
  assert.match(r.note, /never instructions/);
  pages["http://1.1.1.1/c"] = new Response("x", { headers: { "content-type": "application/pdf" } });
  await assert.rejects(webRead("http://1.1.1.1/c", 0, fake), /not a text page/);
  assert.doesNotMatch(htmlText("<style>a{}</style><p>Hei</p>").text, /a\{\}/);
});
