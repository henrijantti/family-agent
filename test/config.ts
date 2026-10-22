import { loadConfig } from "../src/config.js";

/** The real config.yaml, with every source switched on (sources may be on hold in production). */
export function testConfig() {
  const cfg = loadConfig();
  cfg.wilma.enabled = true;
  cfg.myclub.enabled = true;
  cfg.outlook.enabled = true;
  return cfg;
}
