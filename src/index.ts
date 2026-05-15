#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, execSync } from "child_process";
import {
  Config,
  loadConfig,
  saveConfig,
  detectSSHRemotes,
  detectSSHFromHistory,
  getDefaultLocalSaveDir,
  getDefaultRemoteSaveDir,
  resolveLocalSaveDir,
  normalizeRemoteSaveDir,
} from "./config";
import { promptConfirm, promptSelect, promptInput, promptMultiSelect } from "./prompts";
import { startMonitor } from "./monitor";

const isWindows = process.platform === "win32";

interface ProcessInfo {
  pid: number;
  command: string;
}

function findClipshotProcesses(): ProcessInfo[] {
  const processes: ProcessInfo[] = [];

  try {
    if (isWindows) {
      // Use PowerShell to get node processes with command line (WMIC is deprecated)
      const psScript = `$ProgressPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -like '*clipshot*' -and $_.CommandLine -like '*--daemon*' } | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation`;
      const encoded = Buffer.from(psScript, "utf16le").toString("base64");
      const result = execSync(
        `powershell -NoProfile -WindowStyle Hidden -EncodedCommand ${encoded}`,
        { encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
      );

      for (const line of result.split("\n").slice(1)) { // Skip header
        if (!line.trim()) continue;
        // CSV format: "ProcessId","CommandLine"
        const match = line.match(/"(\d+)","(.*)"/);
        if (match) {
          const pid = parseInt(match[1]);
          if (!isNaN(pid) && pid !== process.pid) {
            processes.push({ pid, command: match[2] });
          }
        }
      }
    } else {
      // Unix: use pgrep
      const result = execSync("pgrep -af 'node.*[c]lipshot.*--daemon'", { encoding: "utf8" });
      for (const line of result.trim().split("\n").filter(Boolean)) {
        const pid = parseInt(line.split(/\s+/)[0]);
        if (!isNaN(pid)) {
          processes.push({ pid, command: line });
        }
      }
    }
  } catch {
    // No processes found
  }

  return processes;
}

function killProcess(pid: number, force = false): void {
  try {
    if (isWindows) {
      execSync(`taskkill /PID ${pid}${force ? " /F" : ""}`, { stdio: "pipe", windowsHide: true });
    } else {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    }
  } catch {
    // Process may have already exited
  }
}

function killAllClipshotProcesses(): number {
  const processes = findClipshotProcesses();

  for (const proc of processes) {
    killProcess(proc.pid);
  }

  // Check if any survived and force kill
  const remaining = findClipshotProcesses();
  for (const proc of remaining) {
    killProcess(proc.pid, true);
  }

  return processes.length;
}

function getVersion(): string {
  const pkgPath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  return pkg.version;
}

async function addRemotes(existing: string[]): Promise<string[]> {
  const remotes = [...existing];

  // Collect all detected remotes
  const allDetected: { name: string; source: string }[] = [];

  // From SSH config
  const sshHosts = detectSSHRemotes();
  for (const host of sshHosts) {
    // Use user@host format if user is specified, otherwise just host name
    const remoteName = host.user ? `${host.user}@${host.name}` : host.name;
    if (!remotes.includes(remoteName)) {
      allDetected.push({
        name: remoteName,
        source: "config",
      });
    }
  }

  // From bash/zsh history
  const historyRemotes = detectSSHFromHistory();
  for (const remote of historyRemotes) {
    if (!remotes.includes(remote) && !allDetected.find(d => d.name === remote)) {
      allDetected.push({
        name: remote,
        source: "history",
      });
    }
  }

  if (allDetected.length > 0) {
    const choices = allDetected.map(d => `${d.name} (${d.source})`);

    const selected = await promptMultiSelect(
      "Select SSH remotes to add (space to toggle, enter to confirm)",
      choices
    );

    for (const msg of selected) {
      const detected = allDetected.find(d => `${d.name} (${d.source})` === msg);
      if (detected) {
        remotes.push(detected.name);
      }
    }
  }

  // Add custom remotes
  let addMore = await promptConfirm("Add a custom SSH remote?");
  while (addMore) {
    const remoteName = await promptInput("Enter SSH remote (e.g., user@host)");
    if (remoteName && !remotes.includes(remoteName)) {
      remotes.push(remoteName);
      console.log(`Added: ${remoteName}`);
    }
    addMore = await promptConfirm("Add another?");
  }

  return remotes;
}

function startBackground(remote: string): void {
  let child;

  if (isWindows) {
    // Windows: use detached mode
    child = spawn(process.execPath, [__filename, "--daemon", remote], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, SHOTMON_BACKGROUND: "1" },
      windowsHide: true,
    });
    child.unref();
    console.log(`Started in background (PID: ${child.pid})`);
  } else {
    // Linux/macOS: use nohup + shell backgrounding to preserve X11/Wayland access
    // The native clipboard library crashes with Node's detached mode
    const logDir = path.join(os.homedir(), ".config", "clipshot", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const cmd = `nohup "${process.execPath}" "${__filename}" --daemon "${remote}" >> "${logDir}/daemon.log" 2>&1 & echo $!`;
    const result = execSync(cmd, {
      encoding: "utf8",
      env: { ...process.env, SHOTMON_BACKGROUND: "1" },
    }).trim();
    console.log(`Started in background (PID: ${result})`);
  }

  console.log(`Logs: ~/.config/clipshot/logs/`);
}

function showHelp(): void {
  console.log(`Usage: clipshot <command>

Commands:
  start      Start monitoring in background
  stop       Stop background process
  status     Show if running
  config     Modify remotes and save directories
  uninstall  Remove config and stop process

Run without command to setup/configure.
`);
}

function uninstall(): void {
  // Stop any running process
  const count = killAllClipshotProcesses();
  if (count > 0) {
    console.log("Stopped running process");
  }

  // Remove config directory
  const configDir = path.join(os.homedir(), ".config", "clipshot");
  if (fs.existsSync(configDir)) {
    fs.rmSync(configDir, { recursive: true });
    console.log(`Removed ${configDir}`);
  }

  console.log("\nNow run: npm uninstall -g clipshot");
}

function stopBackground(): void {
  const count = killAllClipshotProcesses();
  if (count > 0) {
    console.log(`Stopped ${count} process(es)`);
  } else {
    console.log("No clipshot process running");
  }
}

function showStatus(): void {
  const processes = findClipshotProcesses();

  if (processes.length === 0) {
    console.log("Not running");
    return;
  }

  for (const proc of processes) {
    // Try to extract target from command line
    const match = proc.command.match(/--daemon\s+(\S+)/);
    if (match) {
      console.log(`Running (PID: ${proc.pid}) -> ${match[1]}`);
    } else {
      console.log(`Running (PID: ${proc.pid})`);
    }
  }
}

async function runConfig(): Promise<Config> {
  let config: Config | null = loadConfig();

  if (!config) {
    console.log("Welcome! Let's configure clipshot.\n");
    config = {
      remotes: [],
      localSaveDir: getDefaultLocalSaveDir(),
      remoteSaveDir: getDefaultRemoteSaveDir(),
    };
  }

  if (config.remotes.length === 0) {
    console.log("SSH remotes: none\n");

    const setupRemotes = await promptConfirm("Configure SSH remotes now?");
    if (setupRemotes) {
      const remotes = await addRemotes([]);
      config = { ...config, remotes };
      console.log(`\nSaved ${remotes.length} remote(s).`);
    }
  } else {
    console.log(`SSH remotes: ${config.remotes.join(", ")}\n`);

    const modify = await promptConfirm("Modify remotes?");
    if (modify) {
      const toKeep = await promptMultiSelect(
        "Select remotes to keep (space to toggle, enter to confirm)",
        config.remotes
      );

      const remotes = await addRemotes(toKeep);
      config = { ...config, remotes };
      console.log(`\nSaved ${remotes.length} remote(s).`);
    }
  }

  console.log(`\nLocal save directory: ${config.localSaveDir}\n`);

  const modifyLocalSaveDir = await promptConfirm("Modify local save directory?");
  if (modifyLocalSaveDir) {
    const input = await promptInput("Enter local save directory", config.localSaveDir);
    config = {
      ...config,
      localSaveDir: resolveLocalSaveDir(input || config.localSaveDir),
    };
    console.log(`\nUpdated local save directory: ${config.localSaveDir}`);
  }

  console.log(`\nRemote save directory: ${config.remoteSaveDir}\n`);

  const modifyRemoteSaveDir = await promptConfirm("Modify remote save directory?");
  if (modifyRemoteSaveDir) {
    const input = await promptInput("Enter remote save directory", config.remoteSaveDir);
    config = {
      ...config,
      remoteSaveDir: normalizeRemoteSaveDir(input || config.remoteSaveDir),
    };
    console.log(`\nUpdated remote save directory: ${config.remoteSaveDir}`);
  }

  saveConfig(config);
  console.log("\nConfiguration saved.");

  return config;
}

async function startCommand(): Promise<void> {
  const config = loadConfig();

  if (!config) {
    console.log("No configuration found. Run 'clipshot' first to set up.");
    process.exit(1);
  }

  // Add "local" option to the list
  const options = ["local", ...config.remotes];

  let selected: string;
  if (options.length === 1) {
    selected = options[0];
  } else {
    selected = await promptSelect("Select target", options);
  }

  // Stop any existing process before starting new one
  const count = killAllClipshotProcesses();
  if (count > 0) {
    console.log(`Stopped previous process`);
  }

  startBackground(selected);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // Handle --daemon (internal use)
  if (command === "--daemon") {
    const remote = args[1];
    if (remote) {
      await startMonitor(remote);
    }
    return;
  }

  console.log(`clipshot v${getVersion()}\n`);

  // Handle commands
  if (command === "help" || command === "--help" || command === "-h") {
    showHelp();
    return;
  }

  if (command === "stop") {
    stopBackground();
    return;
  }

  if (command === "status") {
    showStatus();
    return;
  }

  if (command === "start") {
    await startCommand();
    return;
  }

  if (command === "config") {
    await runConfig();
    return;
  }

  if (command === "uninstall") {
    uninstall();
    return;
  }

  // No command - run config flow then auto-start
  const config = await runConfig();

  if (config.remotes.length === 0) {
    console.log("No SSH remotes configured. Starting in local mode.");
  }

  console.log("\n--- Starting monitor ---\n");
  await startCommand();
}

main().catch(console.error);
