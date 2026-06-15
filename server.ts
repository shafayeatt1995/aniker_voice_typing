import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import qrcode from "qrcode-terminal";
import index from "./public/index.html";

const execFileAsync = promisify(execFile);

const MAX_TEXT_LENGTH = 5000;
const COMMAND_TIMEOUT_MS = 90_000;
const TYPE_DELAY_MS = 0;
const PORT = 8080;
const HOST = "0.0.0.0";
const ROOT_YDOTOOL_SOCKET = "/tmp/.ydotool_socket";
const YDOTOOL_SUDO_WRAPPER = join(import.meta.dir, "scripts", "ydotool-sudo.sh");

type PasteBody = { text?: string };
type PasteSuccess = { ok: true; message: string };
type PasteError = { ok: false; error: string };
type InputMethod = "ydotool-type" | "clipboard-ydotool" | "xdotool-type";

type YdotoolAccess = {
  socket: string;
  viaSudo: boolean;
};

function jsonResponse(body: PasteSuccess | PasteError, status = 200): Response {
  return Response.json(body, { status });
}

function getSessionEnv(): NodeJS.ProcessEnv {
  const uid = process.getuid?.() ?? 1000;
  return {
    ...process.env,
    DISPLAY: process.env.DISPLAY ?? ":0",
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? "wayland-0",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`,
  };
}

function socketExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function socketReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function getUserYdotoolSocket(): string {
  const uid = process.getuid?.() ?? 1000;
  return `${process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`}/.ydotool_socket`;
}

let sudoYdotoolOk: boolean | null = null;

function canSudoYdotool(): boolean {
  if (sudoYdotoolOk !== null) return sudoYdotoolOk;
  try {
    sudoYdotoolOk =
      Bun.spawnSync(["sudo", "-n", YDOTOOL_SUDO_WRAPPER, "help"], {
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0;
  } catch {
    sudoYdotoolOk = false;
  }
  return sudoYdotoolOk;
}

function probeYdotoolSocket(socket: string): boolean {
  try {
    return (
      Bun.spawnSync(["ydotool", "help"], {
        env: { ...getSessionEnv(), YDOTOOL_SOCKET: socket },
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0
    );
  } catch {
    return false;
  }
}

function getYdotoolAccess(): YdotoolAccess | null {
  if (!Bun.which("ydotool")) return null;

  const userSocket = getUserYdotoolSocket();
  const userWorks =
    socketReadable(userSocket) && probeYdotoolSocket(userSocket);

  // Prefer sudo ydotoold (/tmp socket) — matches: sudo ydotoold + bun run dev
  if (socketExists(ROOT_YDOTOOL_SOCKET) && canSudoYdotool()) {
    return { socket: ROOT_YDOTOOL_SOCKET, viaSudo: true };
  }

  if (userWorks) {
    return { socket: userSocket, viaSudo: false };
  }

  if (socketExists(ROOT_YDOTOOL_SOCKET)) {
    return null;
  }

  return null;
}

function findInputMethod(): InputMethod | null {
  if (getYdotoolAccess()) return "ydotool-type";
  if (Bun.which("xdotool")) return "xdotool-type";
  if (getYdotoolAccess() && (Bun.which("wl-copy") || Bun.which("xclip"))) {
    return "clipboard-ydotool";
  }
  return null;
}

const ydotoolAccess = getYdotoolAccess();
const inputMethod = findInputMethod();

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timed out`)),
        COMMAND_TIMEOUT_MS
      );
    }),
  ]);
}

function spawnWithStdin(
  command: string,
  args: string[],
  text: string,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  return withTimeout(
    new Promise((resolve, reject) => {
      const proc = spawn(command, args, { env: env ?? getSessionEnv() });
      let stderr = "";

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on("error", (err) =>
        reject(new Error(`Failed to start ${command}: ${err.message}`))
      );
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(stderr.trim() || `${command} exited with code ${code}`)
          );
      });

      proc.stdin.write(text);
      proc.stdin.end();
    }),
    command
  );
}

async function runCommand(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<void> {
  try {
    await withTimeout(
      execFileAsync(command, args, { env: env ?? getSessionEnv() }).then(
        () => {}
      ),
      command
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.replace(/^Command failed: /, "").trim() || message);
  }
}

async function runYdotool(args: string[]): Promise<void> {
  const access = getYdotoolAccess();
  if (!access) {
    if (socketExists(ROOT_YDOTOOL_SOCKET) && !canSudoYdotool()) {
      throw new Error(
        "sudo ydotoold is running but setup is needed. Run: bash setup.sh"
      );
    }
    throw new Error("ydotool daemon not running. Run: sudo ydotoold");
  }

  const env = { ...getSessionEnv(), YDOTOOL_SOCKET: access.socket };

  if (access.viaSudo) {
    if (!canSudoYdotool()) {
      throw new Error("Run: bash setup.sh");
    }
    await runCommand("sudo", ["-n", YDOTOOL_SUDO_WRAPPER, ...args], env);
    return;
  }

  await runCommand("ydotool", args, env);
}

async function typeText(text: string): Promise<void> {
  await delay(TYPE_DELAY_MS);
  await runYdotool(["type", text]);
}

async function copyToClipboard(text: string): Promise<void> {
  if (Bun.which("wl-copy")) {
    return spawnWithStdin("wl-copy", [], text);
  }
  if (Bun.which("xclip")) {
    return spawnWithStdin("xclip", ["-selection", "clipboard"], text);
  }
  throw new Error("No clipboard tool found");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTextToPc(text: string): Promise<void> {
  const method = inputMethod ?? findInputMethod();

  if (!method) {
    throw new Error("No input method. Run: sudo ydotoold");
  }

  switch (method) {
    case "ydotool-type":
      await typeText(text);
      return;
    case "clipboard-ydotool":
      await copyToClipboard(text);
      await delay(200);
      await runYdotool(["key", "-d", "40", "29:1", "47:1", "47:0", "29:0"]);
      return;
    case "xdotool-type":
      await delay(TYPE_DELAY_MS);
      await spawnWithStdin("xdotool", ["type", "--file", "-"], text);
      return;
  }
}

function methodLabel(method: InputMethod | null): string {
  switch (method) {
    case "ydotool-type":
      return ydotoolAccess?.viaSudo
        ? "ydotool type via sudo (real key presses)"
        : "ydotool type (real key presses)";
    case "clipboard-ydotool":
      return "clipboard + Ctrl+V";
    case "xdotool-type":
      return "xdotool type";
    default:
      return "not found";
  }
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function getLocalIPv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const iface of Object.values(networkInterfaces())) {
    if (!iface) continue;
    for (const net of iface) {
      const isIPv4 = String(net.family) === "IPv4" || String(net.family) === "4";
      if (isIPv4 && !net.internal && isPrivateIPv4(net.address)) {
        addresses.push(net.address);
      }
    }
  }
  return [...new Set(addresses)];
}

function pickPrimaryIp(ips: string[]): string | null {
  if (ips.length === 0) return null;
  return ips.find((ip) => ip.startsWith("192.168.")) ?? ips[0];
}

function printStartupInfo(): void {
  const ips = getLocalIPv4Addresses();
  const primaryIp = pickPrimaryIp(ips);

  console.log("\nPhone Voice Paste is running\n");

  if (inputMethod) {
    console.log(`  Method: ${methodLabel(inputMethod)}`);
  } else {
    console.warn("  Method: not ready — run: sudo ydotoold");
  }

  if (ydotoolAccess) {
    console.log(
      `  ydotool socket: ${ydotoolAccess.socket}${ydotoolAccess.viaSudo ? " (sudo)" : ""}`
    );
  } else if (socketExists(ROOT_YDOTOOL_SOCKET)) {
    console.warn(
      "  ydotool: sudo ydotoold detected — run once: bash setup.sh"
    );
  } else {
    console.warn("  ydotool: start daemon — sudo ydotoold");
  }

  if (ips.length === 0) {
    console.log(`  http://127.0.0.1:${PORT}`);
    console.log("\n  LAN IP not found — run: ip addr\n");
    return;
  }

  for (const ip of ips) console.log(`  http://${ip}:${PORT}`);
  if (!primaryIp) return;

  const url = `http://${primaryIp}:${PORT}`;
  console.log(`\nScan with your phone (same WiFi):\n`);
  qrcode.generate(url, { small: true }, (qr) => {
    console.log(qr);
    console.log(`\n  ${url}\n`);
  });
}

async function handlePaste(req: Request): Promise<Response> {
  let body: PasteBody;
  try {
    body = (await req.json()) as PasteBody;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
  }

  const { text } = body;
  if (typeof text !== "string" || text.length === 0) {
    return jsonResponse({ ok: false, error: "No text to send" }, 400);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return jsonResponse(
      { ok: false, error: `Text too long (max ${MAX_TEXT_LENGTH} characters)` },
      400
    );
  }

  try {
    await sendTextToPc(text);
    return jsonResponse({ ok: true, message: "Text pasted successfully" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to paste text";
    console.error("Paste failed:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  routes: {
    "/": index,
    "/paste": { POST: handlePaste },
  },
  development: { hmr: true, console: true },
});

printStartupInfo();

export { server };
