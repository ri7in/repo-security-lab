import { spawn } from "node:child_process";
import { writeFileSync, writeSync } from "node:fs";
import process from "node:process";
import { setInterval, setTimeout } from "node:timers";

const [mode, markerPath, pidPath] = process.argv.slice(2);

if (mode === "grandchild") {
  setTimeout(() => {
    writeFileSync(markerPath, "survived\n", { flag: "wx" });
  }, 350);
  setInterval(() => {}, 10_000);
} else if (mode === "success") {
  writeSync(1, "bounded stdout");
  writeSync(2, "bounded stderr");
} else if (mode === "nonzero") {
  process.exitCode = 7;
} else if (mode === "race") {
  setTimeout(() => process.exit(0), 50);
} else if (
  mode === "lingering" ||
  mode === "escaped" ||
  mode === "waiting" ||
  mode === "stdout-overflow" ||
  mode === "stderr-overflow"
) {
  const descendant = spawn(
    process.execPath,
    [import.meta.filename, "grandchild", markerPath, pidPath],
    { detached: mode === "escaped", stdio: "inherit" },
  );
  writeFileSync(pidPath, String(descendant.pid));
  if (mode === "lingering" || mode === "escaped") {
    writeSync(1, "leader output");
    process.exit(0);
  }
  if (mode === "stdout-overflow") writeSync(1, "x".repeat(4_096));
  if (mode === "stderr-overflow") writeSync(2, "x".repeat(4_096));
  setInterval(() => {}, 10_000);
} else {
  throw new Error("unknown synthetic process mode");
}
