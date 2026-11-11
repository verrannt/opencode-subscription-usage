// Sidebar gauges for subscription usage: every Claude Code login (5h + 7d) and every ChatGPT/Codex
// login stored in OpenCode. Plain JS against the opentui Solid runtime, so no JSX build step is needed.
// The palette, level colours, gauge layout, session provider and sidebar checks, compact text
// and slot wiring are adapted from @davidaayers/opencode-codex-usage-plugin (MIT); see
// THIRD_PARTY_NOTICES.md.
import { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import {
  createElement,
  createTextNode,
  effect,
  insert,
  insertNode,
  setProp,
  useTerminalDimensions,
} from "@opentui/solid"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { cacheState, formatCountdown, lastStep } from "./cache.js"
import { activeClaudeDir, claudeEmail, discoverClaudeAccounts, fetchClaudeUsage, switchClaudeDir } from "./claude.js"
import { fetchCodexUsage, isCodexCredential } from "./codex.js"
import { cachePath, formatPercent, gauge, gaugeColumns, loadUsage, shortReset, statusNote } from "./usage.js"

const CLAUDE_PROVIDER_ID = "claude-agent"
const OPENAI_PROVIDER_ID = "openai"
const DEFAULT_REFRESH_MINUTES = 5
// How often the credential list and the shared cache files are re-read; a usage request is
// only sent when one is due.
const TICK_MS = 30_000
const LAYOUT_WIDTH = 32
const COLUMN_GAP = 2
const LABEL_WIDTH = 3
const CACHE_LABEL_WIDTH = 6
const CACHE_WARNING_MS = 2 * 60_000

// Minimal hyperscript over the Solid universal renderer: function props/children are reactive.
function h(tag, props = {}, ...children) {
  const el = createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "function") effect((prev) => setProp(el, key, value(), prev))
    else setProp(el, key, value)
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue
    if (typeof child === "function") insert(el, child, null)
    else if (typeof child === "string" || typeof child === "number") insertNode(el, createTextNode(String(child)))
    else insertNode(el, child)
  }
  return el
}

function palette(api) {
  const text = api.theme.text
  return {
    text: text.base,
    muted: text.muted,
    accent: text.action.primary.base,
    success: text.feedback.success.base,
    warning: text.feedback.warning.base,
    error: text.feedback.error.base,
  }
}

function levelColor(percent, theme) {
  if (percent >= 90) return theme.error
  if (percent >= 75) return theme.warning
  if (percent >= 50) return theme.accent
  return theme.success
}

function sessionProvider(api, sessionID) {
  const messages = api.data.session.message.list(sessionID) ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === "assistant" && message.model?.providerID) return message.model.providerID
  }
  const model = api.data.session.get(sessionID)?.model ?? api.ui.model.current()
  return model?.providerID
}

function isSidebarVisible(api, sessionID, width) {
  if (api.data.session.get(sessionID)?.parentID) return false
  return api.options.compact !== true && width > 120
}

function refreshMs(api) {
  const minutes = Number(api.options.refreshMinutes)
  return Math.max(1, Number.isFinite(minutes) ? minutes : DEFAULT_REFRESH_MINUTES) * 60_000
}

// Every Claude Code config directory (default first), then every ChatGPT login in OpenCode's
// credential order. Claude labels and the ✓ are set in `label` once logged-out ones are hidden.
async function discoverAccounts(api) {
  const activeDir = await activeClaudeDir()
  const claude = await discoverClaudeAccounts(undefined, [activeDir, process.env.CLAUDE_CONFIG_DIR].filter(Boolean))
  const accounts = claude.map(({ name, dir }, i) => ({
    // discoverClaudeAccounts lists ~/.claude first; its cache keeps the single-account name.
    key: i === 0 ? "claude" : `claude-${name}`,
    provider: CLAUDE_PROVIDER_ID,
    name,
    dir,
    active: dir === activeDir,
    fetch: () => fetchClaudeUsage(dir),
  }))
  let credentials = []
  try {
    const response = await api.client.credential.list()
    credentials = Array.isArray(response) ? response : (response?.data ?? [])
  } catch {}
  const codex = credentials.filter(isCodexCredential)
  for (const credential of codex) {
    accounts.push({
      key: `codex-${credential.id}`,
      provider: OPENAI_PROVIDER_ID,
      label: `Codex · ${credential.label}`,
      active: credential.active === true,
      marked: credential.active === true && codex.length > 1,
      fetch: () => fetchCodexUsage(credential),
    })
  }
  return accounts
}

// With one Claude login the section is just "Claude"; with several, "Claude · <name>" and a ✓ on
// the one the Claude Agent provider uses.
function label(accounts) {
  const claude = accounts.filter((account) => account.provider === CLAUDE_PROVIDER_ID)
  return accounts.map(({ name, ...account }) =>
    account.provider === CLAUDE_PROVIDER_ID
      ? {
          ...account,
          name,
          label: claude.length > 1 ? `Claude · ${name}` : "Claude",
          marked: account.active && claude.length > 1,
        }
      : account,
  )
}

// One store shared by every view, backed by the cross-window cache files in usage.js. It only
// touches credentials, the cache (and possibly the network) while some view wants data.
function createStore(api) {
  // null while loading; otherwise [{ key, provider, label, active, marked, entry }].
  const [accounts, setAccounts] = createSignal(null, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) })
  const [now, setNow] = createSignal(Date.now())
  let demand = 0
  let inFlight

  const refresh = (force = false) => {
    if (demand === 0 || inFlight) return inFlight
    inFlight = (async () => {
      const discovered = await discoverAccounts(api)
      const entries = await Promise.all(
        discovered.map((account) =>
          loadUsage({
            intervalMs: refreshMs(api),
            force,
            path: cachePath(account.key),
            legacyPath: cachePath(account.key, true),
            fetcher: account.fetch,
          }).catch(
            (error) => ({ error: error?.message ?? "Usage unavailable" }),
          ),
        ),
      )
      setAccounts(
        label(
          discovered
            .map(({ fetch, ...account }, i) => ({ ...account, entry: entries[i] }))
            // Hide a Claude config directory entirely when it has no Claude Code login.
            .filter((account) => !(account.entry.code === "no_login" && !account.entry.usage)),
        ),
      )
    })().finally(() => {
      inFlight = undefined
      setNow(Date.now())
      api.renderer.requestRender()
    })
    return inFlight
  }

  const tick = setInterval(() => refresh(), TICK_MS)

  return {
    accounts,
    now,
    refresh,
    want() {
      demand++
      if (demand === 1) refresh()
      return () => demand--
    },
    dispose() {
      clearInterval(tick)
    },
  }
}

// Registers demand while `active()` is true.
function useDemand(store, active) {
  effect(() => {
    if (!active()) return
    const release = store.want()
    onCleanup(release)
  })
}

function Gauge(api, store, window, width) {
  const theme = () => palette(api)
  const color = () => levelColor(window.usedPercent, theme())
  const bar = gauge(window.usedPercent, width - LABEL_WIDTH - 1)
  const percent = formatPercent(window.usedPercent)
  const reset = () => {
    const suffix = ` · ${shortReset(window.resetsAt, store.now())}`
    const available = width - percent.length
    return suffix.length > available ? `${suffix.slice(0, available - 1)}…` : suffix
  }
  return h(
    "box",
    { flexDirection: "column", flexShrink: 0, width },
    h(
      "box",
      { flexDirection: "row" },
      h("text", { fg: () => theme().muted }, `${window.label.padEnd(LABEL_WIDTH)} `),
      h(
        "text",
        { flexShrink: 0, width: width - LABEL_WIDTH - 1 },
        h("span", { style: () => ({ fg: color() }) }, bar.fill),
        h("span", { style: () => ({ fg: theme().muted }) }, bar.track),
      ),
    ),
    h(
      "text",
      { width, wrapMode: "none", truncate: true },
      h("span", { style: () => ({ fg: color() }) }, percent),
      h("span", { style: () => ({ fg: theme().muted }) }, reset),
    ),
  )
}

// A window the plan doesn't have: a dashed bar and "n/a", so every account keeps the same columns.
function UnavailableGauge(api, label, width) {
  const muted = () => palette(api).muted
  return h(
    "box",
    { flexDirection: "column", flexShrink: 0, width },
    h("text", { fg: muted, width, wrapMode: "none" }, `${label.padEnd(LABEL_WIDTH)} ${"─".repeat(width - LABEL_WIDTH - 1)}`),
    h("text", { fg: muted }, "n/a"),
  )
}

function Gauges(api, store, usage) {
  const columns = gaugeColumns(usage.windows)
  if (columns.length === 0) return h("text", { fg: () => palette(api).muted }, "No usage windows")
  const width = columns.length === 1 ? LAYOUT_WIDTH : (LAYOUT_WIDTH - COLUMN_GAP) / 2
  return h(
    "box",
    { flexDirection: "row", width: LAYOUT_WIDTH, columnGap: COLUMN_GAP },
    columns.map((column) =>
      column.unavailable ? UnavailableGauge(api, column.label, width) : Gauge(api, store, column, width),
    ),
  )
}

function AccountView(api, store, account) {
  const theme = () => palette(api)
  const { entry } = account
  const note = () => statusNote(entry, store.now())
  return h(
    "box",
    { flexDirection: "column" },
    h(
      "text",
      { width: LAYOUT_WIDTH, wrapMode: "none", truncate: true },
      h("span", { style: () => ({ fg: theme().text }) }, account.label),
      account.marked ? h("span", { style: () => ({ fg: theme().text }) }, " ✓") : null,
    ),
    entry.usage
      ? Gauges(api, store, entry.usage)
      : note()
        ? null
        : h("text", { fg: () => theme().muted }, "No usage yet"),
    // With numbers on screen, a failure is a muted note; without them it's a warning.
    () =>
      note()
        ? h(
            "text",
            { fg: () => (entry.usage ? theme().muted : theme().warning), width: LAYOUT_WIDTH, wrapMode: "none", truncate: true },
            note,
          )
        : null,
  )
}

// Estimated prompt-cache lifetime left for this session, counting down every second.
function CacheView(api, sessionID) {
  const theme = () => palette(api)
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => {
    setNow(Date.now())
    api.renderer.requestRender()
  }, 1000)
  onCleanup(() => clearInterval(timer))
  const state = createMemo(() =>
    cacheState({
      step: lastStep(api.data.session.message.list(sessionID()) ?? []),
      running: api.data.session.status(sessionID()) === "running",
      now: now(),
      overrides: api.options.cacheMinutes,
    }),
  )
  // Rebuild the row only when it appears or disappears; the countdown updates in place.
  const visible = createMemo(() => state().status !== "none")
  const text = () => {
    const current = state()
    if (current.status === "running") return "active"
    if (current.status === "expired") return "expired"
    return formatCountdown(current.remainingMs)
  }
  // The time turns red in the last two minutes; "active" and "expired" stay muted.
  const color = () => {
    const current = state()
    if (current.status === "warm") return current.remainingMs < CACHE_WARNING_MS ? theme().error : theme().text
    return theme().muted
  }
  return () =>
    visible()
      ? h(
          "box",
          { flexDirection: "column" },
          h("text", {}, " "),
          h(
            "text",
            { wrapMode: "none" },
            h("span", { style: () => ({ fg: theme().muted }) }, "Cache".padEnd(CACHE_LABEL_WIDTH)),
            h("span", { style: () => ({ fg: color() }) }, text),
          ),
        )
      : null
}

function SidebarView(api, store, sessionID) {
  useDemand(store, () => true)
  const theme = () => palette(api)
  return h(
    "box",
    { flexDirection: "column" },
    h("text", { fg: () => theme().text, attributes: TextAttributes.BOLD }, "Usage"),
    () => {
      const accounts = store.accounts()
      if (!accounts) return h("text", { fg: () => theme().muted }, "Loading...")
      if (accounts.length === 0) return h("text", { fg: () => theme().muted }, "No Claude or ChatGPT login")
      return accounts.map((account) => AccountView(api, store, account))
    },
    CacheView(api, sessionID),
  )
}

// The account the session is using: the active Claude login or OpenCode's active ChatGPT login.
function sessionAccount(accounts, providerID) {
  if (!accounts) return undefined
  if (providerID !== CLAUDE_PROVIDER_ID && providerID !== OPENAI_PROVIDER_ID) return undefined
  return accounts.find((account) => account.provider === providerID && account.active)
}

function CompactView(api, store, sessionID) {
  const dimensions = useTerminalDimensions()
  const provider = createMemo(() => sessionProvider(api, sessionID()))
  const visible = createMemo(
    () =>
      (provider() === CLAUDE_PROVIDER_ID || provider() === OPENAI_PROVIDER_ID) &&
      !isSidebarVisible(api, sessionID(), dimensions().width),
  )
  useDemand(store, visible)
  const text = () => {
    const account = sessionAccount(store.accounts(), provider())
    const windows = account?.entry.usage?.windows ?? []
    if (windows.length === 0) return ""
    const worst = windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))
    const name = account.provider === CLAUDE_PROVIDER_ID ? "Claude" : "Codex"
    return `${name} ${worst.label} ${formatPercent(worst.usedPercent)}`
  }
  return h("box", { visible }, h("text", { fg: () => palette(api).muted }, text))
}

// Picks which Claude login the Claude Agent provider uses. Lists the logged-in config directories
// with their email and usage, then sets the service's CLAUDE_CONFIG_DIR.
async function switchClaudeAccount(api, store) {
  const release = store.want()
  try {
    await store.refresh()
    const claude = (store.accounts() ?? []).filter((account) => account.provider === CLAUDE_PROVIDER_ID)
    if (claude.length < 2) {
      api.ui.toast.show({
        message: "Only one Claude login. Add one with CLAUDE_CONFIG_DIR=~/.claude-<name> claude",
        variant: "info",
      })
      return
    }
    const emails = await Promise.all(claude.map((account) => claudeEmail(account.dir)))
    const usage = (account) =>
      (account.entry.usage?.windows ?? []).map((window) => `${window.label} ${formatPercent(window.usedPercent)}`).join(" · ")
    const dir = await api.ui.dialog.select({
      title: "Claude account",
      current: claude.find((account) => account.active)?.dir,
      options: claude.map((account, i) => ({
        title: account.name,
        value: account.dir,
        description: [emails[i], usage(account), account.entry.error].filter(Boolean).join("  "),
      })),
    })
    const target = claude.find((account) => account.dir === dir)
    if (!target || target.active) return
    const running = (api.data.session.list() ?? []).some((session) => api.data.session.status(session.id) === "running")
    if (
      running &&
      !(await api.ui.dialog.confirm({
        title: "Switch Claude account?",
        message: "Switching restarts the OpenCode service and interrupts running sessions.",
        label: { confirm: "Switch", cancel: "Cancel" },
      }))
    )
      return
    await switchClaudeDir(target.dir)
    api.ui.toast.show({ message: `Claude Agent now uses ${target.name}`, variant: "success" })
    await store.refresh(true)
  } catch (error) {
    api.ui.toast.show({ message: `Switching Claude account failed: ${error?.message ?? error}`, variant: "error" })
  } finally {
    release()
  }
}

export default Plugin.define({
  id: "subscription-usage",
  setup(api) {
    const store = createStore(api)
    const sidebar = api.ui.slot({
      prepend: "sidebar.content",
      render: (props) => SidebarView(api, store, () => props.sessionID),
    })
    const compact = api.ui.slot({
      append: "prompt.footer.status",
      render: (props) =>
        h("box", {}, () => (props.sessionID ? CompactView(api, store, () => props.sessionID) : h("box", { visible: false }))),
    })
    api.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "subscription-usage.refresh",
          title: "Refresh subscription usage",
          group: "Usage",
          palette: true,
          slash: { name: "subscription-usage", aliases: ["claude-usage"] },
          run: () => store.refresh(true),
        },
        {
          id: "subscription-usage.claude-switch-account",
          title: "Switch Claude account",
          group: "Usage",
          palette: true,
          slash: { name: "claude-switch-account" },
          run: () => switchClaudeAccount(api, store),
        },
      ],
    }))
    return () => {
      sidebar()
      compact()
      store.dispose()
    }
  },
})
