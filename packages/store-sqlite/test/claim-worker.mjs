import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const { filename, workerId, nowMs, expiresAtMs, sql, gate } = workerData;
const barrier = new Int32Array(gate);
Atomics.add(barrier, 0, 1);
Atomics.notify(barrier, 0);
while (Atomics.load(barrier, 1) === 0) {
  Atomics.wait(barrier, 1, 0);
}

try {
  const database = new Database(filename);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  const row = database.prepare(sql).get(workerId, expiresAtMs, nowMs);
  database.close();
  parentPort.postMessage({ repositoryId: row?.repository_id ?? null });
} catch {
  parentPort.postMessage({ error: "claim worker failed" });
}
