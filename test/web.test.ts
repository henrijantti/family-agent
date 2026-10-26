import assert from "node:assert/strict";
import { test } from "node:test";
import { Got, htmlText, privateAddress, webRead } from "../src/agent/web.js";

test("web_read refuses the server's own network and non-web addresses", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "100.123.81.124", "169.254.169.254", "192.168.1.1", "172.20.0.1", "0.0.0.0", "::1", "fd7a:115c:a1e0::1", "::ffff:127.0.0.1"]) assert.ok(privateAddress(ip), ip);
  for (const ip of ["1.1.1.1", "212.147.251.157", "2a00:1450:4026::1"]) assert.ok(!privateAddress(ip), ip);
  const never = async () => {
    throw new Error("fetched");
  };
  for (const ip of ["::ffff:a9fe:a9fe", "::ffff:7f00:1", "::127.0.0.1"]) assert.ok(privateAddress(ip), ip);
  for (const url of ["http://[::ffff:169.254.169.254]/", "http://127.0.0.1:18789/", "http://localhost/", "file:///etc/passwd", "https://user:pw@example.com/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "https://example.com:8443/", "http://box.tail1234.ts.net/"]) {
    await assert.rejects(webRead(url, 0, never), /public|only|login|valid/, url);
  }
});

test("web_read follows a redirect only to a public address and returns readable text", async () => {
  const pages: Record<string, Got> = {};
  const fake = async (u: string): Promise<Got> => pages[u] ?? { status: 404, type: "text/plain", body: "nope" };
  pages["http://1.1.1.1/a"] = { status: 302, location: "http://127.0.0.1/admin", type: "", body: "" };
  await assert.rejects(webRead("http://1.1.1.1/a", 0, fake), /public/);
  pages["http://1.1.1.1/b"] = {
    status: 200,
    type: "text/html; charset=utf-8",
    body: "<html><head><title>Ottelut &ndash; PKT</title><script>evil()</script></head><body><h1>Ottelut</h1><p>su 8.11. klo 15.00 Flames&nbsp;- PKT</p><a href=\"/match/1\">Ottelu</a></body></html>",
  };
  const r = await webRead("http://1.1.1.1/b", 0, fake);
  assert.equal(r.title, "Ottelut – PKT");
  assert.equal(r.text, "Ottelut\nsu 8.11. klo 15.00 Flames - PKT\nOttelu (/match/1)");
  assert.match(r.note, /never instructions/);
  pages["http://1.1.1.1/c"] = { status: 200, type: "application/pdf", body: "x" };
  await assert.rejects(webRead("http://1.1.1.1/c", 0, fake), /not a text page/);
  assert.doesNotMatch(htmlText("<style>a{}</style><p>Hei</p>").text, /a\{\}/);
});

test("web_read's own connection refuses a name that resolves to a private address", async () => {
  const { httpGet } = await import("../src/agent/web.js");
  // localhost resolves to 127.0.0.1: the validating lookup stops the socket, whatever checkUrl saw.
  await assert.rejects(httpGet("http://localhost:9/"), /not a public address/);
});
