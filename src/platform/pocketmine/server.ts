import path from "node:path";
import fs from "node:fs";
import crypto from "crypto";
import node_cron from "cron";
import * as child_process from "../../childProcess";
import { backupRoot, serverRoot } from "../../pathControl";
import { BdsSession, bdsSessionCommands, serverListen, playerAction2 } from '../../globalType';
import { gitBackup, gitBackupOption } from "../../backup/git";
import { createZipBackup } from "../../backup/zip";
import events from "../../lib/customEvents";

const pocketmineSesions: {[key: string]: BdsSession} = {};
export function getSessions() {return pocketmineSesions;}

const ServerPath = path.join(serverRoot, "pocketmine");
export async function startServer(): Promise<BdsSession> {
  const SessionID = crypto.randomUUID();
  const Process: {command: string; args: Array<string>; env: {[env: string]: string};} = {
    command: "",
    args: [],
    env: {...process.env}
  };
  Process.args.push(path.join(ServerPath, "PocketMine.phar"));
  if (process.platform === "win32") Process.command = path.resolve(ServerPath, "bin/php/php.exe");
  else {
    Process.command = path.resolve(ServerPath, "bin/bin/php");
    await child_process.runAsync("chmod", ["a+x", Process.command]);
  }

  // Start Server
  const serverEvents = new events();
  const StartDate = new Date();
  const ServerProcess = await child_process.execServer({runOn: "host"}, Process.command, Process.args, {env: Process.env, cwd: ServerPath});
  const { onExit, on: execOn } = ServerProcess;
  // Log Server redirect to callbacks events and exit
  execOn("out", data => serverEvents.emit("log_stdout", data));
  execOn("err", data => serverEvents.emit("log_stderr", data));
  execOn("all", data => serverEvents.emit("log", data));
  onExit().catch(err => {serverEvents.emit("err", err);return null}).then(code => serverEvents.emit("closed", code));

  // Run Command
  const serverCommands: bdsSessionCommands = {
    /**
     * Run any commands in server.
     * @param command - Run any commands in server without parse commands
     * @returns - Server commands
     */
    execCommand: (...command) => {
      ServerProcess.writelf(command.map(a => String(a)).join(" "));
      return serverCommands;
    },
    tpPlayer: (player: string, x: number, y: number, z: number) => {
      serverCommands.execCommand("tp", player, x, y, z);
      return serverCommands;
    },
    worldGamemode: (gamemode: "survival"|"creative"|"hardcore") => {
      serverCommands.execCommand("gamemode", gamemode);
      return serverCommands;
    },
    userGamemode: (player: string, gamemode: "survival"|"creative"|"hardcore") => {
      serverCommands.execCommand("gamemode", gamemode, player);
      return serverCommands;
    },
    stop: (): Promise<number|null> => {
      if (ServerProcess.Exec.exitCode !== null||ServerProcess.Exec.killed) return Promise.resolve(ServerProcess.Exec.exitCode);
      if (ServerProcess.Exec.killed) return Promise.resolve(ServerProcess.Exec.exitCode);
      ServerProcess.writelf("stop");
      return ServerProcess.onExit();
    }
  }

  const backupCron = (crontime: string|Date, option?: {type: "git"; config: gitBackupOption}|{type: "zip", config?: {pathZip?: string}}): node_cron.CronJob => {
    // Validate Config
    if (option) {
      if (option.type === "git") {
        if (!option.config) throw new Error("Config is required");
      } else if (option.type === "zip") {}
      else option = {type: "zip"};
    }
    async function lockServerBackup() {
      serverCommands.execCommand("save hold");
      await new Promise(accept => setTimeout(accept, 1000));
      serverCommands.execCommand("save query");
      await new Promise(accept => setTimeout(accept, 1000));
    }
    async function unLockServerBackup() {
      serverCommands.execCommand("save resume");
      await new Promise(accept => setTimeout(accept, 1000));
    }
    if (!option) option = {type: "zip"};
    const CrontimeBackup = new node_cron.CronJob(crontime, async () => {
      if (option.type === "git") {
        await lockServerBackup();
        await gitBackup(option.config).catch(() => undefined).then(() => unLockServerBackup());
      } else if (option.type === "zip") {
        await lockServerBackup();
        if (!!option?.config?.pathZip) await createZipBackup({path: path.resolve(backupRoot, option?.config?.pathZip)}).catch(() => undefined);
        else await createZipBackup(true).catch(() => undefined);
        await unLockServerBackup();
      }
    });
    CrontimeBackup.start();
    serverEvents.on("closed", () => CrontimeBackup.stop());
    return CrontimeBackup;
  }

  // Session log
  const logFile = path.resolve(process.env.LOG_PATH||path.resolve(ServerPath, "../log"), `bedrock_${SessionID}.log`);
  if(!(fs.existsSync(path.parse(logFile).dir))) fs.mkdirSync(path.parse(logFile).dir, {recursive: true});
  const logStream = fs.createWriteStream(logFile, {flags: "w+"});
  logStream.write(`[${StartDate.toString()}] Server started\n\n`);
  ServerProcess.Exec.stdout.pipe(logStream);
  ServerProcess.Exec.stderr.pipe(logStream);

  // Session Object
  const Seesion: BdsSession = {
    id: SessionID,
    creteBackup: backupCron,
    ports: [],
    Player: {},
    seed: undefined,
    commands: serverCommands,
    server: {
      on: (act, fn) => serverEvents.on(act, fn),
      once: (act, fn) => serverEvents.once(act, fn),
      startDate: StartDate,
      started: false
    }
  };

  // On server started
  serverEvents.on("log", lineData => {
    // [22:52:05.580] [Server thread/INFO]: Done (0.583s)! For help, type "help" or "?"
    if (/\[.*\].*\s+Done\s+\(.*\)\!.*/.test(lineData)) {
      const StartDate = new Date();
      Seesion.server.startDate = StartDate;
      serverEvents.emit("started", StartDate);
      Seesion.server.started = true;
    }
  });

  // Port listen
  serverEvents.on("log", data => {
    // [16:49:31.284] [Server thread/INFO]: Minecraft network interface running on [::]:19133
    // [16:49:31.273] [Server thread/INFO]: Minecraft network interface running on 0.0.0.0:19132
    if (/\[.*\]:\s+Minecraft\s+network\s+interface\s+running\s+on\s+.*/gi.test(data)) {
      const matchString = data.match(/\[.*\]:\s+Minecraft\s+network\s+interface\s+running\s+on\s+(.*)/);
      if (!!matchString) {
        const portParse = matchString[1];
        const isIpv6 = /\[.*\]:/.test(portParse);
        const portObject: serverListen = {port: 0, version: "IPv4"};
        if (!isIpv6) portObject.port = parseInt(portParse.split(":")[1]);
        else {
          portObject.port = parseInt(portParse.replace(/\[.*\]:/, "").trim())
          portObject.version = "IPv6";
        }
        serverEvents.emit("port_listen", portObject);
        Seesion.ports.push(portObject);
      }
    }
  });

  // Player Actions
  serverEvents.on("log", data => {
    if (/\[.*\]:\s+(.*)\s+(.*)\s+the\s+game/gi.test(data)) {
      const actionDate = new Date();
      const [action, player] = (data.match(/[.*]:\s+(.*)\s+(.*)\s+the\s+game/gi)||[]).slice(1, 3);
      const __PlayerAction: playerAction2 = {player: player, action: "unknown", Date: actionDate};
      if (action === "joined") __PlayerAction.action = "connect";
      else if (action === "left") __PlayerAction.action = "disconnect";
      if (!Seesion.Player[__PlayerAction.player]) Seesion.Player[__PlayerAction.player] = {
        action: __PlayerAction.action,
        date: actionDate,
        history: [{
          action: __PlayerAction.action,
          date: actionDate
        }]
      }; else {
        Seesion.Player[__PlayerAction.player].action = __PlayerAction.action;
        Seesion.Player[__PlayerAction.player].date = actionDate;
        Seesion.Player[__PlayerAction.player].history.push({
          action: __PlayerAction.action,
          date: actionDate
        });
      }

      // Server player event
      serverEvents.emit("player", __PlayerAction);
      delete __PlayerAction.action;
      if (action === "connect") serverEvents.emit("player_connect", __PlayerAction);
      else if (action === "disconnect") serverEvents.emit("player_disconnect", __PlayerAction);
      else serverEvents.emit("player_unknown", __PlayerAction);
    }
  });

  // Return Session
  pocketmineSesions[SessionID] = Seesion;
  serverEvents.on("closed", () => delete pocketmineSesions[SessionID]);
  return Seesion;
}