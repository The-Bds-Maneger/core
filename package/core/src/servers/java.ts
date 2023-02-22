import { manegerOptions, serverManeger } from "../serverManeger.js";
import coreHttp, { large } from "@sirherobrine23/http";
import utils from "node:util";
import path from "node:path";

export type javaOptions = manegerOptions & {
  /**
   * Servidor alternativo ao invés do servidor ofical da Mojang
   */
  altServer?: "spigot"|"paper"|"purpur"
};

export async function listVersions(options: Omit<javaOptions, keyof manegerOptions>) {
  if (options.altServer === "purpur") {
    return Promise.all((await coreHttp.jsonRequest<{versions: string[]}>("https://api.purpurmc.org/v2/purpur")).body.versions.map(async version => ({
      version,
      downloadUrl: utils.format("https://api.purpurmc.org/v2/purpur/%s/latest/download", version),
      date: new Date((await coreHttp.jsonRequest<{timestamp: number}>(utils.format("https://api.purpurmc.org/v2/purpur/%s/latest", version))).body.timestamp)
    })));
  } else if (options.altServer === "paper") {
    return Promise.all((await coreHttp.jsonRequest<{versions: string[]}>("https://api.papermc.io/v2/projects/paper")).body.versions.map(async version => {
      const build = (await coreHttp.jsonRequest<{builds: number[]}>(utils.format("https://api.papermc.io/v2/projects/paper/versions/%s", version))).body.builds.at(-1);
      const data = (await coreHttp.jsonRequest<{time: string, downloads: {[k: string]: {name: string, sha256: string}}}>(utils.format("https://api.papermc.io/v2/projects/paper/versions/%s/builds/%s", version, build))).body;

      return {
        version,
        date: new Date(data.time),
        downloadUrl: utils.format("https://api.papermc.io/v2/projects/paper/versions/%s/builds/%s/downloads/%s", version, build, data.downloads["application"].name)
      }
    }));
  } else if (options.altServer === "spigot") {
    throw new Error("Não foi implementado!");
  }
    return (await Promise.all((await coreHttp.jsonRequest<{versions: {id: string, releaseTime: string, url: string}[]}>("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json")).body.versions.map(async data => ({
    version: data.id,
    date: new Date(data.releaseTime),
    downloadUrl: (await coreHttp.jsonRequest<{downloads: {[k: string]: {size: number, url: string}}}>(data.url)).body.downloads?.["server"]?.url
  })))).filter(a => !!a.downloadUrl);
}

export async function installServer(options: javaOptions & {version?: string}) {
  const serverPath = await serverManeger(options);
  const version = (await listVersions(options)).find(rel => (!options.version || options.version === "latest" || rel.version === options.version));
  if (!version) throw new Error("Não existe a versão informada!");
  await large.saveFile({
    path: path.join(serverPath.serverFolder, "server.jar"),
    url: version.downloadUrl
  });
  return {
    ...version,
    id: serverPath.id,
  };
}

export async function startServer(options: javaOptions) {
  const serverPath = await serverManeger(options);
  return serverPath.runCommand({
    command: "java",
    args: [
      "-XX:+UseG1GC",
      "-XX:+ParallelRefProcEnabled",
      "-XX:MaxGCPauseMillis=200",
      "-XX:+UnlockExperimentalVMOptions",
      "-XX:+DisableExplicitGC",
      "-XX:+AlwaysPreTouch",
      "-XX:G1NewSizePercent=30",
      "-XX:G1MaxNewSizePercent=40",
      "-XX:G1HeapRegionSize=8M",
      "-XX:G1ReservePercent=20",
      "-XX:G1HeapWastePercent=5",
      "-XX:G1MixedGCCountTarget=4",
      "-XX:InitiatingHeapOccupancyPercent=15",
      "-XX:G1MixedGCLiveThresholdPercent=90",
      "-XX:G1RSetUpdatingPauseTimePercent=5",
      "-XX:SurvivorRatio=32",
      "-XX:+PerfDisableSharedMem",
      "-XX:MaxTenuringThreshold=1",
      "-Dusing.aikars.flags=https://mcflags.emc.gs",
      "-Daikars.new.flags=true",
      "-jar", "server.jar",
    ],
    serverActions: {
      stop(child) {
        child.sendCommand("stop");
      },
    }
  });
}