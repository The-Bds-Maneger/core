import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import child_process from "child_process";
import node_cron from "cron";
import addon from "./addons/index";
import * as bdsBackup from "./backup";
import * as serverConfig from "./serverConfig";
import * as bdsTypes from "./globalType";

type BdsSession = {
  id: string;
  startDate: Date;
  seed?: string;
  addonManeger: {
    installAddon: (packPath: string) => Promise<void>;
    installAllAddons: (removeOldPacks: boolean) => Promise<void>;
  };
  creteBackup: (crontime: string|Date) => void;
  on: (from: "all"|"stdout"|"stderr", callback: (data: string) => void) => void;
  exit: (callback: (code: number, signal: string) => void) => void;
  getPlayer: () => {[player: string]: {action: "connect"|"disconnect"|"unknown"; date: Date; history: Array<{action: "connect"|"disconnect"|"unknown"; date: Date}>}};
  ports: () => Array<{port: number; protocol: "TCP"|"UDP"; version?: "IPv4"|"IPv6"}>;
  commands: {
    tpPlayer: (username: string, x: number, y: number, z: number) => void;
    execCommand: (command: string) => void;
    stop: () => Promise<number|null>
  }
};

// Server Sessions
const Sessions: {[Session: string]: BdsSession} = {};
export function getSessions() {return Sessions;}

// Start Server
export async function Start(Platform: bdsTypes.Platform): Promise<BdsSession> {
  const ServerPath = path.resolve(process.env.SERVER_PATH||path.join(os.homedir(), "bds_core/servers"), Platform);
  if (!(fs.existsSync(ServerPath))) fs.mkdirSync(ServerPath, {recursive: true});
  const Process: {command: string; args: Array<string>; env: {[env: string]: string};} = {
    command: "",
    args: [],
    env: {...process.env}
  };
  if (Platform === "bedrock") {
    if (process.platform === "darwin") throw new Error("Run Docker image");
    Process.command = path.resolve(ServerPath, "bedrock_server"+(process.platform === "win32"?".exe":""));
    if (process.platform !== "win32") {
      child_process.execFileSync("chmod", ["a+x", Process.command]);
      Process.env.LD_LIBRARY_PATH = path.resolve(ServerPath, "bedrock");
      if (process.arch !== "x64") {
        console.warn("Minecraft bedrock start with emulated x64 architecture");
        Process.args.push(Process.command);
        Process.command = "qemu-x86_64-static";
      }
    }
  } else if (Platform === "java"||Platform === "spigot") {
    Process.command = "java";
    Process.args.push("-jar");
    if (Platform === "java") Process.args.push(path.resolve(ServerPath, "Server.jar"));
    else Process.args.push(path.resolve(ServerPath, "Spigot.jar"));
  } else if (Platform === "pocketmine") {
    if (process.platform === "win32") Process.command = path.resolve(ServerPath, "php/php");
    else Process.command = path.resolve(ServerPath, "php7/bin/php");
    Process.args.push(path.resolve(ServerPath, "PocketMine-MP.phar"));
  }

  // Start Server
  console.log(Process.command, ...Process.args);
  const ServerProcess = child_process.execFile(Process.command, Process.args, {env: Process.env, cwd: ServerPath, maxBuffer: Infinity});
  const StartDate = new Date();

  // Log callback
  const onLog = (from: "all"|"stdout"|"stderr", callback: (data: string) => void) => {
    if (from === "all") {
      ServerProcess.stdout.on("data", callback);
      ServerProcess.stderr.on("data", callback);
    } else if (from === "stderr") ServerProcess.stderr.on("data", callback);
    else if (from === "stdout") ServerProcess.stdout.on("data", callback);
    else throw new Error("Unknown log from");
    return;
  }

  const playersConnections: {[player: string]: {action: "connect"|"disconnect"|"unknown"; date: Date; history: Array<{action: "connect"|"disconnect"|"unknown"; date: Date}>}} = {};
  const ports: Array<{port: number; protocol: "TCP"|"UDP"; version?: "IPv4"|"IPv6"}> = [];
  onLog("all", data => {
    if (Platform === "bedrock") {
      (() => {
          const portParse = data.match(/(IPv[46])\s+.*,\s+port:\s+(.*)/);
          if (portParse) ports.push({
            port: parseInt(portParse[2]),
            protocol: "UDP",
            version: portParse[1] as "IPv4"|"IPv6"
          });
          const portParse2 = data.match(/port:\s+(.*)/);
          if (portParse2) {
            if (!ports.find(p => p.port === parseInt(portParse2[1]))) ports.push({
              port: parseInt(portParse2[1]),
              protocol: "UDP",
            });
          }
        })()
        const playerBedrock = (() => {
          const [action, player, xuid] = (data.match(/r\s+(.*)\:\s+(.*)\,\s+xuid\:\s+(.*)/)||[]).slice(1, 4);
          const __PlayerAction: {player: string, xuid: string|undefined, action: "connect"|"disconnect"|"unknown"} = {
            player: player,
            xuid: xuid,
            action: "unknown"
          };
          if (action === "connected") __PlayerAction.action = "connect";
          else if (action === "disconnected") __PlayerAction.action = "disconnect";
          return __PlayerAction;
        })();
        if (playerBedrock.player && playerBedrock.action) {
        const actionDate = new Date();
        if (!!playersConnections[playerBedrock.player]) {
          playersConnections[playerBedrock.player].action = playerBedrock.action;
          playersConnections[playerBedrock.player].date = actionDate;
          playersConnections[playerBedrock.player].history.push({action: playerBedrock.action, date: actionDate});
        } else {
          playersConnections[playerBedrock.player] = {
            action: playerBedrock.action,
            date: actionDate,
            history: [{action: playerBedrock.action, date: actionDate}]
          };
        }
      }
    }
  });

  // Exit callback
  const onExit = (callback: (code: number, signal: string) => void): void => {
    ServerProcess.on("exit", callback);
  }

  // Run Command
  const execCommand = (...command) => {
    ServerProcess.stdin.write(command.join(" ")+"\n");
    return;
  };

  // Teleport player
  const tpPlayer = (username: string, x: number, y: number, z: number) => {
    execCommand("tp", username, x, y, z);
    return;
  }

  // Stop Server
  const stopServer: () => Promise<number|null> = () => {
    execCommand("stop");
    return new Promise((accept, reject) => {
      ServerProcess.on("exit", code => code === 0 ? accept(code) : reject(code));
      setTimeout(() => accept(null), 1000);
    })
  }

  // Return Session
  const Seesion: BdsSession = {
    id: crypto.randomUUID(),
    startDate: StartDate,
    seed: undefined,
    addonManeger: {
      installAddon: async function (packPath: string) {console.log(packPath); return;},
      installAllAddons: async function (removeOldPacks: boolean) {console.log(removeOldPacks); return;}
    },
    creteBackup: (crontime: string|Date) => {
      const cronJob = new node_cron.CronJob(crontime, async () => {
        if (Platform === "bedrock") {
          execCommand("save hold");
          execCommand("save query");
        }
        await bdsBackup.CreateBackup(Platform);
        if (Platform === "bedrock") execCommand("save resume");
      });
      ServerProcess.on("exit", () => cronJob.stop());
      cronJob.start();
      return;
    },
    on: onLog,
    exit: onExit,
    ports: () => ports,
    getPlayer: () => playersConnections,
    commands: {
      execCommand: execCommand,
      tpPlayer: tpPlayer,
      stop: stopServer
    }
  };
  if (Platform === "bedrock") {
    Seesion.addonManeger = addon.bedrock.addonInstaller();
    const bedrockConfig = await serverConfig.parseConfig(Platform);
    if (bedrockConfig.nbt) Seesion.seed = bedrockConfig.nbt.parsed.value.RandomSeed.value.toString();
  }
  const logFile = path.resolve(process.env.LOG_PATH||path.resolve(ServerPath, "../log"), `${Platform}_${Seesion.id}.log`);
  if(!(fs.existsSync(path.parse(logFile).dir))) fs.mkdirSync(path.parse(logFile).dir, {recursive: true});
  const logStream = fs.createWriteStream(logFile, {flags: "w+"});
  logStream.write(`[${StartDate.toISOString()}] Server started\n\n`);
  onLog("all", data => logStream.write(data));
  Sessions[Seesion.id] = Seesion;
  ServerProcess.on("exit", () => {delete Sessions[Seesion.id];});
  return Seesion;
}