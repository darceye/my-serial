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
import type { DataChunk } from "$lib/services/rx-buffer";

export type ExportFormat = "txt" | "csv" | "hex";

/** Legacy alias for callers that still pass a {ts,dir,text} tuple to
 *  appendLog. Export uses DataChunk (which carries raw bytes) directly. */
export interface LogLine {
  ts: number; // epoch ms
  dir: "rx" | "tx" | "system";
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
    const dirTag = line.dir.toUpperCase();
    const entry = `[${ts}] ${dirTag} ${JSON.stringify(line.text)}\n`;
    await writeTextFile(path, entry, { append: true });
  } catch (e) {
    console.warn("appendLog failed:", e);
  }
}

/** Export captured chunks to a file in the chosen format. Returns the path.
 *
 *  Now consumes DataChunk[] (raw bytes + decoded text) so hex export no longer
 *  needs to re-encode text back to bytes — it reads chunk.bytes directly,
 *  which preserves the original byte sequence exactly. */
export async function exportLines(
  sessionTag: string,
  chunks: DataChunk[],
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
    for (const c of chunks) {
      const escaped = c.text.replace(/"/g, '""').replace(/\r?\n/g, "\\n");
      rows.push(`${new Date(c.ts).toISOString()},${c.dir},"${escaped}"`);
    }
    content = rows.join("\n");
  } else if (format === "hex") {
    // Concatenate raw bytes across chunks (skip system markers, which have
    // no bytes anyway).
    const totalLen = chunks.reduce((n, c) => n + c.bytes.length, 0);
    const all = new Uint8Array(totalLen);
    let p = 0;
    for (const c of chunks) {
      all.set(c.bytes, p);
      p += c.bytes.length;
    }
    const hex: string[] = [];
    for (let i = 0; i < all.length; i += 16) {
      const row = Array.from(all.slice(i, i + 16));
      const offset = i.toString(16).padStart(8, "0");
      const hexPart = row.map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(48);
      const ascii = row
        .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
        .join("");
      hex.push(`${offset}  ${hexPart}  |${ascii}|`);
    }
    content = hex.join("\n");
  } else {
    // txt: concatenate decoded text.
    content = chunks.map((c) => c.text).join("");
  }
  await writeTextFile(path, content);
  return path;
}
