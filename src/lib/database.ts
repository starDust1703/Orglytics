import "server-only";

import fs from "node:fs";
import path from "node:path";

function readBackendEnvValue(name: string) {
  const envPath = path.join(process.cwd(), "src", "backend", ".env");

  try {
    const line = fs
      .readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .find((entry) => entry.trim().startsWith(`${name}=`));

    return line?.slice(line.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  } catch {
    return undefined;
  }
}

export function getDatabaseUrl() {
  return process.env.DATABASE_URL?.trim() || readBackendEnvValue("DATABASE_URL");
}
