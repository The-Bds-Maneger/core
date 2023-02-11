import { pathOptions } from "../serverManeger.js";

export type javaRootOption = pathOptions & {
  variant?: "oficial"|"Spigot"|"Paper"|"Purpur",
};

export async function installServer(options?: javaRootOption) {
  options = {variant: "oficial", ...options};
  if (options?.variant === "Spigot") {
  } else if (options?.variant === "Paper") {
  } else if (options?.variant === "Purpur") {
  } else {}
}

export default startServer;
export async function startServer(options?: javaRootOption) {}