import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  activeClaudeDir,
  claudeEmail,
  discoverClaudeAccounts,
  fetchClaudeUsage,
  keychainService,
  readClaudeCredentials,
  switchClaudeDir,
} from "../claude.js"

test("discoverClaudeAccounts lists the default directory, then ~/.claude-<name> directories by name", async () => {
  const home = await mkdtemp(join(tmpdir(), "subscription-usage-home-"))
  for (const name of [".claude", ".claude-work", ".claude-personal", ".claude-", ".claudex"]) await mkdir(join(home, name))
  await writeFile(join(home, ".claude-file"), "")
  assert.deepEqual(await discoverClaudeAccounts(home), [
    { name: "default", dir: join(home, ".claude") },
    { name: "personal", dir: join(home, ".claude-personal") },
    { name: "work", dir: join(home, ".claude-work") },
  ])
})

test("discoverClaudeAccounts adds extra directories that aren't listed yet", async () => {
  const home = await mkdtemp(join(tmpdir(), "subscription-usage-home-"))
  await mkdir(join(home, ".claude-work"))
  const accounts = await discoverClaudeAccounts(home, [
    join(home, ".claude-work") + "/",
    join(home, ".config", "claude"),
    join(home, ".config", "claude"),
  ])
  assert.deepEqual(accounts, [
    { name: "default", dir: join(home, ".claude") },
    { name: "work", dir: join(home, ".claude-work") },
    { name: "claude", dir: join(home, ".config", "claude") },
  ])
})

test("discoverClaudeAccounts always includes the default directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "subscription-usage-home-"))
  assert.deepEqual(await discoverClaudeAccounts(home), [{ name: "default", dir: join(home, ".claude") }])
})

test("keychainService matches Claude Code's per-directory entry names", () => {
  assert.equal(keychainService("/Users/me/.claude", "/Users/me"), "Claude Code-credentials")
  // sha256("/Users/me/.claude-work") starts with 1e91dd84.
  assert.equal(keychainService("/Users/me/.claude-work", "/Users/me"), "Claude Code-credentials-1e91dd84")
})

test("activeClaudeDir reads the service's CLAUDE_CONFIG_DIR, defaulting to ~/.claude", async () => {
  let args
  const set = async (command, a) => {
    args = [command, ...a]
    return "/Users/me/.claude-work\n"
  }
  assert.equal(await activeClaudeDir("/Users/me", set), "/Users/me/.claude-work")
  assert.equal(await activeClaudeDir("/Users/me", async () => "/Users/me/.claude-work/\n"), "/Users/me/.claude-work")
  assert.deepEqual(args, ["opencode", "service", "get", "env", "CLAUDE_CONFIG_DIR"])
  assert.equal(await activeClaudeDir("/Users/me", async () => "\n"), "/Users/me/.claude")
  assert.equal(
    await activeClaudeDir("/Users/me", async () => {
      throw new Error("no opencode")
    }),
    "/Users/me/.claude",
  )
})

test("switchClaudeDir sets CLAUDE_CONFIG_DIR, or unsets it for the default directory", async () => {
  const calls = []
  const runner = async (command, args) => calls.push([command, ...args].join(" "))
  await switchClaudeDir("/Users/me/.claude-work", "/Users/me", runner)
  await switchClaudeDir("/Users/me/.claude", "/Users/me", runner)
  assert.deepEqual(calls, [
    "opencode service set env CLAUDE_CONFIG_DIR /Users/me/.claude-work",
    "opencode service unset env CLAUDE_CONFIG_DIR",
  ])
})

test("claudeEmail reads ~/.claude.json for the default directory and <dir>/.claude.json otherwise", async () => {
  const home = await mkdtemp(join(tmpdir(), "subscription-usage-home-"))
  await mkdir(join(home, ".claude-work"))
  await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@home" } }))
  await writeFile(join(home, ".claude-work", ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@work" } }))
  assert.equal(await claudeEmail(join(home, ".claude"), home), "me@home")
  assert.equal(await claudeEmail(join(home, ".claude-work"), home), "me@work")
  assert.equal(await claudeEmail(join(home, ".claude-missing"), home), "")
})

async function credentialsDir(oauth) {
  const dir = await mkdtemp(join(tmpdir(), "subscription-usage-claude-"))
  if (oauth) await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }))
  return dir
}

test("readClaudeCredentials falls back to the directory's .credentials.json", async () => {
  const dir = await credentialsDir({ accessToken: "tok", expiresAt: 5 })
  assert.deepEqual(await readClaudeCredentials(dir), { accessToken: "tok", expiresAt: 5 })
  await assert.rejects(readClaudeCredentials(await credentialsDir()), { code: "no_login" })
})

test("fetchClaudeUsage skips the request for an expired token", async () => {
  const dir = await credentialsDir({ accessToken: "tok", expiresAt: 1000 })
  await assert.rejects(fetchClaudeUsage(dir, 1000), { code: "expired" })
})
