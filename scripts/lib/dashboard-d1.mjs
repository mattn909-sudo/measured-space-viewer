import { spawnSync } from "node:child_process";

export const DEFAULT_DATABASE = "measured-space-dashboard";
const BOOLEAN_OPTIONS = new Set(["allow-example", "help", "local", "remote"]);

export function parseArgs(args) {
  const positional = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const key = arg.slice(2);
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }
  return { positional, options };
}

export function getDatabaseOptions(options = {}) {
  if (options.local && options.remote) {
    throw new Error("Use either --local or --remote, not both.");
  }

  return {
    database: options.database,
    local: !options.remote,
    remote: Boolean(options.remote),
  };
}

export function wranglerD1Execute(sql, options = {}) {
  const database = options.database || DEFAULT_DATABASE;
  const args = ["wrangler", "d1", "execute", database, "--command", sql];
  if (options.remote) {
    args.push("--remote");
  } else {
    args.push("--local");
  }
  if (options.json) {
    args.push("--json");
  }

  printCommand("npx", args);
  const result = spawnSync("npx", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(`Wrangler D1 command failed with exit code ${result.status}.`);
  }

  return result.stdout;
}

export function readJsonRows(output) {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }

  const firstJson = trimmed.search(/[\[{]/);
  if (firstJson === -1) {
    return [];
  }

  const parsed = JSON.parse(trimmed.slice(firstJson));
  if (Array.isArray(parsed)) {
    return parsed.flatMap((item) => item.results || []);
  }
  return parsed.results || [];
}

export function sqlLiteral(value) {
  if (value == null || value === "") {
    return "NULL";
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function sqlNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? String(Math.round(number)) : "0";
}

export function normalizeEmail(value) {
  const email = cleanString(value).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("A valid --email address is required.");
  }
  return email;
}

export function normalizeRole(value) {
  const role = cleanString(value).toLowerCase() || "viewer";
  if (!["viewer", "manager", "owner"].includes(role)) {
    throw new Error("--role must be viewer, manager, or owner.");
  }
  return role;
}

export function normalizeRequiredString(value, label) {
  const text = cleanString(value);
  if (!text) {
    throw new Error(`${label} is required.`);
  }
  return text;
}

export function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function printCommand(command, args) {
  console.log(`$ ${[command, ...args].map(formatShellArg).join(" ")}`);
}

function formatShellArg(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}
