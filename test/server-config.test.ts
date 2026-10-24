import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

// Server and laptop config is copied to machines by hand, so a typo only shows
// up there. These checks catch it in CI instead.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SERVER = join(ROOT, "server");
const PLUGINS = join(ROOT, "openclaw", "plugins");

test("every server/*.json5 parses", () => {
  const files = readdirSync(SERVER).filter((f) => f.endsWith(".json5"));
  assert.ok(files.length > 0);
  for (const f of files) {
    assert.doesNotThrow(() => JSON5.parse(readFileSync(join(SERVER, f), "utf8")), f);
  }
});

test("every OpenClaw plugin loads at gateway startup", () => {
  // Without activation.onStartup the plugin never loads on 2026.10.6, and the
  // mail Allow card silently never appears (fixed in PR #9).
  const plugins = readdirSync(PLUGINS, { withFileTypes: true }).filter((d) => d.isDirectory());
  assert.ok(plugins.length > 0);
  for (const p of plugins) {
    const manifest = JSON.parse(readFileSync(join(PLUGINS, p.name, "openclaw.plugin.json"), "utf8"));
    assert.equal(manifest.activation?.onStartup, true, `${p.name}: activation.onStartup must be true`);
  }
});

test("laptop permission templates parse and keep the hard denies", () => {
  const project = JSON.parse(readFileSync(join(SERVER, "laptop", "project-settings.json"), "utf8"));
  const deny: string[] = project.permissions.deny;
  for (const rule of ["approvals resolve * allow", "openclaw update", ".secrets", "git push origin main", "git push --force"]) {
    assert.ok(deny.some((d) => d.includes(rule)), `deny rule missing: ${rule}`);
  }
  const user = JSON.parse(readFileSync(join(SERVER, "laptop", "user-automode.json"), "utf8"));
  assert.deepEqual(Object.keys(user), ["autoMode"]);
  assert.ok(user.autoMode.hard_deny.length > 1);
});
