/**
 * Data recording & export service.
 *
 * - Per-session log file: appended on every RX/TX event when logging is enabled.
 * - On-demand export of the current session buffer to txt/csv/hex.
 *
 * Files land under <UserDocuments>/MySerial/logs/. We resolve the Documents
 * directory once via @tauri-apps/api/path and use writeTextFile with an
 * absolute path + append flag (plugin-fs supports absolute paths when the
 * capability grants them).
 */
import { writeTextFile, mkdir, exists } from "@tauri-apps/plugin-fs";
import { documentDir, join } from "@tauri-apps/api/path";

export type ExportFormat = "txt" | "csv" | "hex";

export interface LogLine {
  ts: number; // epoch ms
  dir: "rx" | "tx";
  text: string; // already-decoded UTF-8
}

let logDir: string | null = null;

/** Resolve (and lazily create) the logs directory under the user's Documents. */
async function ensureLogDir(): Promise<string> {
  if (logDir) return logDir;
  const docs = await documentDir();
  logDir = await join(docs, "MySerial", "logs");
  try {
    if (!(await exists(logDir))) {
      await mkdir(logDir, { recursive: true });
    }
  } catch {
    // directory may already exist; ignore
  }
  return logDir;
}

/** Append one line to a session's log file. Best-effort: never throws. */
export async function appendLog(sessionTag: string, line: LogLine): Promise<void> {
  try {
    const dir = await ensureLogDir();
    const date = new Date(line.ts);
    const fname = `${sessionTag}_${date.toISOString().slice(0, 10)}.log`;
    const path = await join(dir, fname);
    const ts = date.toISOString();
    const dirTag = line.dir === "rx" ? "RX" : "TX";
    const entry = `[${ts}] ${dirTag} ${JSON.stringify(line.text)}\n`;
    await writeTextFile(path, entry, { append: true });
  } catch (e) {
    console.warn("appendLog failed:", e);
  }
}

/** Export captured lines to a file in the chosen format. Returns the path. */
export async function exportLines(
  sessionTag: string,
  lines: LogLine[],
  format: ExportFormat,
): Promise<string> {
  const dir = await ensureLogDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const ext = format === "hex" ? "hex" : format;
  const fname = `${sessionTag}_export_${stamp}.${ext}`;
  const path = await join(dir, fname);

  let content: string;
  if (format === "csv") {
    const rows = ["timestamp,direction,data"];
    for (const l of lines) {
      const escaped = l.text.replace(/"/g, '""').replace(/\r?\n/g, "\\n");
      rows.push(`${new Date(l.ts).toISOString()},${l.dir},"${escaped}"`);
    }
    content = rows.join("\n");
  } else if (format === "hex") {
    const allBytes = new TextEncoder().encode(lines.map((l) => l.text).join(""));
    const hex: string[] = [];
    for (let i = 0; i < allBytes.length; i += 16) {
      const chunk = Array.from(allBytes.slice(i, i + 16));
      const offset = i.toString(16).padStart(8, "0");
      const hexPart = chunk.map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(48);
      const ascii = chunk
        .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
        .join("");
      hex.push(`${offset}  ${hexPart}  |${ascii}|`);
    }
    content = hex.join("\n");
  } else {
    content = lines.map((l) => l.text).join("");
  }
  await writeTextFile(path, content);
  return path;
}
