import { loadConfig } from "../src/config.js";

/** The real config.yaml, with every source switched on (sources may be on hold in production). */
export function testConfig() {
  const cfg = loadConfig();
  cfg.wilma.enabled = true;
  cfg.myclub.enabled = true;
  cfg.outlook.enabled = true;
  cfg.digest.language = "en"; // assertions are written against the English labels
  cfg.agent_jobs = []; // tests that need agent-owned jobs set them themselves
  if (cfg.dashboard) delete cfg.dashboard.drive_file_id; // never upload to Henri's Drive from tests
  return cfg;
}
