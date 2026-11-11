// Claude subscription usage (5h session / 7d weekly) via the same endpoint Claude Code's /usage uses.
// Credentials come from Claude Code's own login (`claude auth login`), which opencode's
// "Claude Agent" provider also uses. We only read the access token; we never refresh it,
// because rotating the refresh token here would log Claude Code out.
//
// Each Claude Code config directory is one account: ~/.claude is "default" and ~/.claude-<name>
// is <name>. The Claude Agent provider uses the directory in the OpenCode service's
// CLAUDE_CONFIG_DIR, or ~/.claude when it's unset.
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { EXPIRED_MESSAGE, requestJson, UsageError } from "./usage.js"

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const KEYCHAIN_SERVICE = "Claude Code-credentials"
const DIR_PREFIX = ".claude-"

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })
}

export function defaultClaudeDir(home = homedir()) {
  return join(home, ".claude")
}

function accountName(dir) {
  const base = basename(dir)
  return base.startsWith(DIR_PREFIX) ? base.slice(DIR_PREFIX.length) : base.replace(/^\./, "")
}

// The default directory, then every ~/.claude-<name> directory by name, then any `extraDirs`
// (such as a CLAUDE_CONFIG_DIR elsewhere) not already listed. Directories without a login are
// returned too; their usage fails with code "no_login" and the sidebar hides them.
export async function discoverClaudeAccounts(home = homedir(), extraDirs = []) {
  const accounts = [{ name: "default", dir: defaultClaudeDir(home) }]
  let entries = []
  try {
    entries = await readdir(home, { withFileTypes: true })
  } catch {}
  const named = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(DIR_PREFIX) && entry.name.length > DIR_PREFIX.length)
    .map((entry) => ({ name: accountName(entry.name), dir: join(home, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const all = [...accounts, ...named]
  for (const extra of extraDirs) {
    const dir = resolve(extra)
    if (!all.some((account) => account.dir === dir)) all.push({ name: accountName(dir), dir })
  }
  return all
}

// Claude Code keys its macOS keychain entry by config directory: the default directory uses the
// plain name, any other gets the first 8 hex digits of the directory path's SHA-256 appended.
export function keychainService(dir, home = homedir()) {
  if (dir === defaultClaudeDir(home)) return KEYCHAIN_SERVICE
  return `${KEYCHAIN_SERVICE}-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`
}

// The config directory the OpenCode background service passes to Claude Code.
export async function activeClaudeDir(home = homedir(), runner = run) {
  try {
    const dir = (await runner("opencode", ["service", "get", "env", "CLAUDE_CONFIG_DIR"])).trim()
    if (dir) return resolve(dir)
  } catch {}
  return defaultClaudeDir(home)
}

// Points the service's Claude Agent provider at `dir`. Changing the service environment restarts
// the background service, which interrupts running requests.
export async function switchClaudeDir(dir, home = homedir(), runner = run) {
  if (dir === defaultClaudeDir(home)) await runner("opencode", ["service", "unset", "env", "CLAUDE_CONFIG_DIR"])
  else await runner("opencode", ["service", "set", "env", "CLAUDE_CONFIG_DIR", dir])
}

// The account's email from Claude Code's state file (~/.claude.json for the default directory).
export async function claudeEmail(dir, home = homedir()) {
  const file = dir === defaultClaudeDir(home) ? join(home, ".claude.json") : join(dir, ".claude.json")
  try {
    return JSON.parse(await readFile(file, "utf8")).oauthAccount?.emailAddress ?? ""
  } catch {
    return ""
  }
}

export async function readClaudeCredentials(dir = defaultClaudeDir(), home = homedir()) {
  if (process.platform === "darwin") {
    try {
      const raw = await run("security", ["find-generic-password", "-s", keychainService(dir, home), "-w"])
      const oauth = JSON.parse(raw).claudeAiOauth
      if (oauth?.accessToken) return oauth
    } catch {}
  }
  try {
    const oauth = JSON.parse(await readFile(join(dir, ".credentials.json"), "utf8")).claudeAiOauth
    if (oauth?.accessToken) return oauth
  } catch {}
  throw new UsageError("No Claude login; run `claude auth login`", { code: "no_login" })
}

function toWindow(label, raw) {
  if (!raw || typeof raw.utilization !== "number") return null
  const resetsAt = raw.resets_at ? Date.parse(raw.resets_at) : NaN
  return { label, usedPercent: raw.utilization, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null }
}

export function parseClaudeUsage(body) {
  return { windows: [toWindow("5h", body?.five_hour), toWindow("7d", body?.seven_day)].filter(Boolean) }
}

export async function fetchClaudeUsage(dir = defaultClaudeDir(), now = Date.now()) {
  const { accessToken, expiresAt } = await readClaudeCredentials(dir)
  // An account Claude Code isn't using doesn't get its token refreshed; skip the request.
  if (expiresAt && expiresAt <= now) throw new UsageError(EXPIRED_MESSAGE, { code: "expired" })
  const body = await requestJson(USAGE_URL, {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    "Content-Type": "application/json",
  })
  return parseClaudeUsage(body)
}
