#!/usr/bin/env node
// ============================================================
// One start for wacrm and its embedded WhatsApp gateway (OpenWA,
// vendored under packages/openwa).
//
//   node scripts/wacrm.mjs dev   [next dev args]    npm run dev
//   node scripts/wacrm.mjs start [next start args]  npm run start
//   node scripts/wacrm.mjs build [next build args]  npm run build
//   node scripts/wacrm.mjs openwa:install | openwa:build
//   node scripts/wacrm.mjs cron                     the scheduler alone (compose)
//
// dev/start run Next and OpenWA side by side; when either exits (or on
// Ctrl-C / SIGTERM) both stop. They also run the scheduler: every 60 s
// a tick calls the cron endpoints (automations — which also continues
// broadcasts, the inbound fan-out and the QR history import —, the
// broadcast cron, and the flow sweep every 5 minutes) with the cron
// secret: AUTOMATION_CRON_SECRET from the environment or .env files,
// else one generated once into the data dir (cron.secret, 0600) and
// handed to Next. WACRM_CRON=off turns it off. The gateway's admin API key is a shared
// secret generated on first run and kept in the data dir
// (.openwa-data/gateway.key, 0600). OpenWA seeds it as its admin key
// (API_MASTER_KEY, first boot only); Next gets it as OPENWA_API_KEY.
// Nobody types a URL or a key.
//
// OpenWA's own dependencies stay in packages/openwa (its own lockfile,
// installed here on demand) so they never touch Next's tree.
//
// WACRM_OPENWA=off runs Next alone (serverless hosts, or when the QR
// mode isn't wanted). Vercel builds skip the gateway automatically.
// OPENWA_URL set in the shell (with OPENWA_API_KEY) uses that gateway
// instead of starting the embedded one.
// ============================================================

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OPENWA_DIR = path.join(ROOT, 'packages', 'openwa')
const NEXT_BIN = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
const INSTALL_STAMP = path.join(OPENWA_DIR, 'node_modules', '.wacrm-install-stamp')
const KEY_FILE_NAME = 'gateway.key'
const CRON_SECRET_FILE_NAME = 'cron.secret'
/**
 * The embedded gateway's per-client rate limits (OpenWA's Nest throttler;
 * stock 10/s, 100/min, 1000/h). wacrm is its only client and its API is
 * loopback-only, so the stock hourly cap would only throttle a history
 * import. Next gets the same numbers to pace the import under them.
 */
export const GATEWAY_RATE_LIMITS = { perSecond: 20, perMinute: 600, perHour: 36_000 }
const STOP_GRACE_MS = 20_000
const CRON_FIRST_TICK_MS = 10_000
const CRON_REQUEST_TIMEOUT_MS = 120_000
/** The cron endpoints a tick calls; `every` = once per that many ticks. */
export const CRON_ENDPOINTS = [
  { name: 'automations', path: '/api/automations/cron', every: 1 },
  { name: 'broadcast', path: '/api/whatsapp/broadcast/cron', every: 1 },
  { name: 'flows', path: '/api/flows/cron', every: 5 },
]

const log = (msg) => console.log(`[wacrm] ${msg}`)

function embeddedEnabled() {
  const flag = (process.env.WACRM_OPENWA ?? '').trim().toLowerCase()
  if (['off', 'false', '0', 'no'].includes(flag)) return { on: false, why: 'WACRM_OPENWA=off' }
  if (process.env.VERCEL) return { on: false, why: 'serverless host (Vercel): QR mode needs a long-running server' }
  if (!fs.existsSync(path.join(OPENWA_DIR, 'package.json'))) {
    return { on: false, why: 'packages/openwa is not present' }
  }
  // OpenWA runs on this same Node and needs >= 22.19 (packages/openwa/package.json).
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 19)) {
    return { on: false, why: `Node ${process.versions.node} is too old for the gateway (needs >= 22.19)` }
  }
  return { on: true, why: '' }
}

function dataDir() {
  const dir = path.resolve(ROOT, process.env.WACRM_OPENWA_DATA_DIR?.trim() || '.openwa-data')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status ?? r.signal})`)
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * What an install depends on: the lockfile and the `allowScripts` policy
 * (npm 11 skips install scripts it doesn't cover, so a policy change must
 * reinstall — an install made before it may lack Chrome).
 */
function installStamp() {
  const lock = sha256File(path.join(OPENWA_DIR, 'package-lock.json'))
  const pkg = JSON.parse(fs.readFileSync(path.join(OPENWA_DIR, 'package.json'), 'utf8'))
  const policy = crypto.createHash('sha256').update(JSON.stringify(pkg.allowScripts ?? null)).digest('hex')
  return `${lock}:${policy}`
}

/** `npm ci` in packages/openwa when its lockfile or script policy changed since the last install. */
function ensureOpenWaInstalled({ force = false } = {}) {
  const stamp = installStamp()
  const current = fs.existsSync(INSTALL_STAMP) ? fs.readFileSync(INSTALL_STAMP, 'utf8').trim() : ''
  if (!force && current === stamp) return
  log('installing the WhatsApp gateway dependencies (packages/openwa, first run only)…')
  // npm_config_* from the outer `npm run` would leak into the nested install.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('npm_config_')))
  run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: OPENWA_DIR, env })
  fs.writeFileSync(INSTALL_STAMP, stamp + '\n')
}

/**
 * The native pieces the gateway can't run without, which only exist when
 * their install scripts ran (packages/openwa/package.json `allowScripts`):
 * the Chrome puppeteer downloads (whatsapp-web.js engine) and
 * better-sqlite3's binding. Throws with the fix when one is missing.
 */
function verifyOpenWaRuntime() {
  const probe = (code) =>
    spawnSync(process.execPath, ['-e', code], { cwd: OPENWA_DIR, encoding: 'utf8', env: process.env })
  const problems = []

  const sqlite = probe("new (require('better-sqlite3'))(':memory:').close()")
  if (sqlite.status !== 0) {
    const reason = (sqlite.stderr || '').split('\n').find((l) => /Error/.test(l)) ?? 'it does not load'
    problems.push(
      `better-sqlite3's native binding is missing (${reason.trim()}). ` +
        'Its install script did not run: check `allowScripts` in packages/openwa/package.json, then `npm run openwa:install`.',
    )
  }

  const engine = process.env.OPENWA_ENGINE_TYPE?.trim() || 'whatsapp-web.js'
  if (engine === 'whatsapp-web.js') {
    const chrome = probe("process.stdout.write(process.env.PUPPETEER_EXECUTABLE_PATH || require('puppeteer').executablePath())")
    const chromePath = chrome.status === 0 ? chrome.stdout.trim() : ''
    if (!chromePath || !fs.existsSync(chromePath)) {
      problems.push(
        `the gateway's Chrome is missing${chromePath ? ` (${chromePath})` : ''}. ` +
          "puppeteer's install script did not run (npm 11 blocks scripts not in `allowScripts`). " +
          'Run `npm run openwa:install`, or download it with `cd packages/openwa && node node_modules/puppeteer/install.mjs`. ' +
          'A system Chrome works too: PUPPETEER_EXECUTABLE_PATH=/path/to/chrome.',
      )
    }
  }

  if (problems.length) {
    throw new Error(`the WhatsApp gateway can't start:\n  - ${problems.join('\n  - ')}`)
  }
}

function newestMtime(dir) {
  let newest = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p))
    else newest = Math.max(newest, fs.statSync(p).mtimeMs)
  }
  return newest
}

/** `nest build` when dist/ is missing or older than the sources. */
function ensureOpenWaBuilt({ force = false } = {}) {
  const main = path.join(OPENWA_DIR, 'dist', 'main.js')
  if (!force && fs.existsSync(main) && fs.statSync(main).mtimeMs >= newestMtime(path.join(OPENWA_DIR, 'src'))) {
    return
  }
  log('building the WhatsApp gateway (packages/openwa)…')
  run(process.execPath, [path.join(OPENWA_DIR, 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js'), 'build'], {
    cwd: OPENWA_DIR,
  })
}

/**
 * The gateway's admin key: read it, or adopt the key an existing OpenWA
 * data dir already seeded (data/.api-key), or generate one. Same format
 * OpenWA generates itself (owa_k1_ + 32 random bytes).
 */
export function ensureGatewayKey(dir) {
  const keyFile = path.join(dir, KEY_FILE_NAME)
  if (fs.existsSync(keyFile)) {
    const key = fs.readFileSync(keyFile, 'utf8').trim()
    if (key) return { key, keyFile, source: 'existing' }
  }
  const seeded = path.join(dir, 'data', '.api-key')
  let key = fs.existsSync(seeded) ? fs.readFileSync(seeded, 'utf8').trim() : ''
  const source = key ? 'adopted' : 'generated'
  if (!key) key = `owa_k1_${crypto.randomBytes(32).toString('hex')}`
  fs.writeFileSync(keyFile, key + '\n', { mode: 0o600 })
  return { key, keyFile, source }
}

/** A KEY=value from the .env files Next loads, in Next's order of precedence. */
function envFileValue(key, mode, root = ROOT) {
  const nodeEnv = mode === 'dev' ? 'development' : 'production'
  for (const name of [`.env.${nodeEnv}.local`, '.env.local', `.env.${nodeEnv}`, '.env']) {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) continue
    const m = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm').exec(fs.readFileSync(file, 'utf8'))
    const value = m?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2')
    if (value) return value
  }
  return ''
}

/**
 * The cron endpoints' shared secret: the operator's (environment, then
 * the .env files), else one generated once into the data dir.
 */
export function ensureCronSecret(dir, mode, root = ROOT) {
  const configured = process.env.AUTOMATION_CRON_SECRET?.trim() || envFileValue('AUTOMATION_CRON_SECRET', mode, root)
  if (configured) return { secret: configured, source: 'configured' }
  const file = path.join(dir, CRON_SECRET_FILE_NAME)
  const stored = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''
  if (stored) return { secret: stored, source: 'existing' }
  const secret = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 })
  return { secret, source: 'generated' }
}

/**
 * One scheduler tick: call each due cron endpoint with the secret.
 * Returns one short line for the log. An endpoint whose previous call
 * is still running is skipped, not stacked.
 */
export async function cronTick({ baseUrl, secret, tick, inFlight = new Set(), fetchImpl = fetch, signal = undefined }) {
  const parts = []
  const started = Date.now()
  await Promise.all(
    CRON_ENDPOINTS.filter((e) => tick % e.every === 0).map(async (e) => {
      if (inFlight.has(e.name)) {
        parts.push(`${e.name} busy`)
        return
      }
      inFlight.add(e.name)
      try {
        const res = await fetchImpl(`${baseUrl}${e.path}`, {
          headers: { 'x-cron-secret': secret },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CRON_REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(CRON_REQUEST_TIMEOUT_MS),
        })
        parts.push(`${e.name} ${res.status}`)
        await res.body?.cancel().catch(() => undefined)
      } catch (err) {
        parts.push(`${e.name} ${err?.name === 'TimeoutError' ? 'timeout' : 'unreachable'}`)
      } finally {
        inFlight.delete(e.name)
      }
    }),
  )
  const order = CRON_ENDPOINTS.map((e) => e.name)
  parts.sort((a, b) => order.indexOf(a.split(' ')[0]) - order.indexOf(b.split(' ')[0]))
  return `${parts.join(' · ')} (${Date.now() - started} ms)`
}

/** Tick every `intervalMs` until stop() — one log line per tick. */
export function startScheduler({ baseUrl, secret, intervalMs, firstTickMs = CRON_FIRST_TICK_MS, write = (l) => console.log(l) }) {
  const inFlight = new Set()
  const controller = new AbortController()
  let tick = 0
  let timer = null
  const run = async () => {
    const line = await cronTick({ baseUrl, secret, tick, inFlight, signal: controller.signal })
    if (!controller.signal.aborted) write(`[cron] tick ${tick}: ${line}`)
    tick++
  }
  const first = setTimeout(() => {
    void run()
    timer = setInterval(() => void run(), intervalMs)
  }, firstTickMs)
  return {
    stop() {
      clearTimeout(first)
      if (timer) clearInterval(timer)
      controller.abort()
    },
  }
}

function cronEnabled() {
  return !['off', 'false', '0', 'no'].includes((process.env.WACRM_CRON ?? '').trim().toLowerCase())
}

function cronIntervalMs() {
  return (Number(process.env.WACRM_CRON_INTERVAL_S) || 60) * 1000
}

/** -p / --port / --port=N from the Next args, else PORT, else 3000. */
function nextPort(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if ((a === '-p' || a === '--port') && args[i + 1]) return Number(args[i + 1])
    const m = /^--port=(\d+)$/.exec(a)
    if (m) return Number(m[1])
  }
  return Number(process.env.PORT) || 3000
}

/** OpenWA gets a short, explicit environment — not Next's (PORT, DATABASE_*, …). */
export function openWaEnv({ mode, port, key }) {
  const pass = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']
  const env = {}
  for (const k of pass) if (process.env[k] !== undefined) env[k] = process.env[k]
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('PUPPETEER_')) env[k] = v
  return {
    ...env,
    NODE_ENV: mode === 'dev' ? 'development' : 'production',
    PORT: String(port),
    LISTEN_HOST: '127.0.0.1',
    BASE_URL: `http://127.0.0.1:${port}`,
    API_MASTER_KEY: key,
    // Webhooks go to Next on this same host.
    SSRF_ALLOWED_HOSTS: '127.0.0.1,localhost',
    ENGINE_TYPE: process.env.OPENWA_ENGINE_TYPE?.trim() || 'whatsapp-web.js',
    // The dashboard SPA isn't built here; wacrm is the UI.
    SERVE_DASHBOARD: 'false',
    RATE_LIMIT_SHORT_LIMIT: String(GATEWAY_RATE_LIMITS.perSecond),
    RATE_LIMIT_MEDIUM_LIMIT: String(GATEWAY_RATE_LIMITS.perMinute),
    RATE_LIMIT_LONG_LIMIT: String(GATEWAY_RATE_LIMITS.perHour),
    // Restart the sessions that were linked when the gateway went down
    // (OpenWA: phone known, status disconnected, not stopped by an
    // operator) — otherwise every `npm run dev` restart leaves the number
    // disconnected until someone starts it by hand. Opt-in upstream.
    // A session that never finished pairing (qr_ready) is not restarted.
    AUTO_START_SESSIONS: process.env.OPENWA_AUTO_START_SESSIONS?.trim() === 'false' ? 'false' : 'true',
  }
}

function prefixed(child, name) {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue
    const out = stream === child.stderr ? process.stderr : process.stdout
    readline.createInterface({ input: stream }).on('line', (line) => out.write(`[${name}] ${line}\n`))
  }
}

async function waitForGateway(url, key, child) {
  const until = Date.now() + 180_000
  while (Date.now() < until && child.exitCode === null) {
    try {
      const res = await fetch(`${url}/api/auth/validate`, {
        method: 'POST',
        headers: { 'X-API-Key': key },
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        const info = await res.json()
        if (info?.valid) return info
        log(`gateway is up but rejected the provisioned key (${JSON.stringify(info)})`)
        return null
      }
      if (res.status === 401) {
        log(
          'gateway is up but rejected the provisioned key: its data dir was seeded with another key. ' +
            `Put that key in ${KEY_FILE_NAME} or start with an empty data dir.`,
        )
        return null
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return null
}

async function serve(mode, nextArgs) {
  const embedded = embeddedEnabled()
  const port = nextPort(nextArgs)
  const nextEnv = { ...process.env }
  const children = []
  let stopping = false

  let scheduler = null

  const stopAll = (code) => {
    if (stopping) return
    stopping = true
    scheduler?.stop()
    process.exitCode = code
    for (const c of children) if (c.exitCode === null) c.kill('SIGTERM')
    setTimeout(() => {
      for (const c of children) if (c.exitCode === null) c.kill('SIGKILL')
    }, STOP_GRACE_MS).unref()
  }

  const external = process.env.OPENWA_URL?.trim()
  if (external) {
    log(`using the WhatsApp gateway at ${external} (OPENWA_URL); the embedded one is not started`)
    if (!process.env.OPENWA_WEBHOOK_BASE_URL) nextEnv.OPENWA_WEBHOOK_BASE_URL = `http://127.0.0.1:${port}`
  } else if (embedded.on) {
    ensureOpenWaInstalled()
    ensureOpenWaBuilt()
    verifyOpenWaRuntime()
    const dir = dataDir()
    const { key, keyFile, source } = ensureGatewayKey(dir)
    const gwPort = Number(process.env.OPENWA_PORT) || 2785
    const gwUrl = `http://127.0.0.1:${gwPort}`
    log(`gateway key ${source} (${path.relative(ROOT, keyFile)}, ${key.slice(0, 10)}…)`)
    log(`gateway: ${gwUrl} (data: ${path.relative(ROOT, dir) || '.'}), webhooks → http://127.0.0.1:${port}`)

    // OpenWA resolves everything under ./data from its working directory.
    const gw = spawn(process.execPath, [path.join(OPENWA_DIR, 'dist', 'main.js')], {
      cwd: dir,
      env: openWaEnv({ mode, port: gwPort, key }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(gw)
    prefixed(gw, 'openwa')
    gw.on('exit', (code, signal) => {
      if (!stopping) log(`gateway exited (${code ?? signal}); stopping wacrm`)
      stopAll(code ?? 1)
    })
    void waitForGateway(gwUrl, key, gw).then((info) => {
      if (info) log(`gateway ready: key accepted (role ${info.role}, engine ${info.engineType})`)
    })

    nextEnv.OPENWA_URL = gwUrl
    nextEnv.OPENWA_API_KEY = key
    nextEnv.OPENWA_RATE_LIMIT_PER_MIN = String(GATEWAY_RATE_LIMITS.perMinute)
    nextEnv.OPENWA_RATE_LIMIT_PER_HOUR = String(GATEWAY_RATE_LIMITS.perHour)
    nextEnv.OPENWA_WEBHOOK_BASE_URL = `http://127.0.0.1:${port}`
  } else {
    log(`WhatsApp gateway not started: ${embedded.why}. QR-code mode is unavailable; the official API mode works.`)
  }

  if (cronEnabled()) {
    const { secret, source } = ensureCronSecret(dataDir(), mode)
    nextEnv.AUTOMATION_CRON_SECRET = secret
    const intervalMs = cronIntervalMs()
    log(
      `scheduler: cron endpoints every ${intervalMs / 1000} s (secret ${source === 'configured' ? 'from AUTOMATION_CRON_SECRET' : `${source}, ${CRON_SECRET_FILE_NAME}`})`,
    )
    scheduler = startScheduler({ baseUrl: `http://127.0.0.1:${port}`, secret, intervalMs })
  } else {
    log('scheduler off (WACRM_CRON=off): nothing calls the cron endpoints')
  }

  const next = spawn(process.execPath, [NEXT_BIN, mode, ...nextArgs], {
    cwd: ROOT,
    env: nextEnv,
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  children.push(next)
  prefixed(next, 'next')
  next.on('exit', (code, signal) => {
    if (!stopping) log(`next exited (${code ?? signal}); stopping wacrm`)
    stopAll(code ?? (signal ? 1 : 0))
  })

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stopAll(0))
}

function build(nextArgs) {
  const embedded = embeddedEnabled()
  if (embedded.on) {
    ensureOpenWaInstalled()
    ensureOpenWaBuilt()
    verifyOpenWaRuntime()
  } else {
    log(`skipping the WhatsApp gateway build: ${embedded.why}`)
  }
  run(process.execPath, [NEXT_BIN, 'build', ...nextArgs], { cwd: ROOT })
}

/** `cron`: the scheduler alone, for a separate container (docker-compose.yml). */
async function cronOnly() {
  const baseUrl = (process.env.WACRM_CRON_URL?.trim() || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  let secret = process.env.AUTOMATION_CRON_SECRET?.trim() || ''
  const file = process.env.AUTOMATION_CRON_SECRET_FILE?.trim()
  if (!secret && file) secret = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''
  if (!secret) throw new Error('no cron secret: set AUTOMATION_CRON_SECRET or AUTOMATION_CRON_SECRET_FILE')
  const intervalMs = cronIntervalMs()
  log(`scheduler: ${baseUrl} every ${intervalMs / 1000} s`)
  const scheduler = startScheduler({ baseUrl, secret, intervalMs })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => scheduler.stop())
}

async function main(cmd, rest) {
  switch (cmd) {
    case 'cron':
      await cronOnly()
      break
    case 'dev':
    case 'start':
      await serve(cmd, rest)
      break
    case 'build':
      build(rest)
      break
    case 'openwa:install':
      ensureOpenWaInstalled({ force: true })
      verifyOpenWaRuntime()
      log('gateway dependencies installed; Chrome and the SQLite binding are in place')
      break
    case 'openwa:build':
      ensureOpenWaInstalled()
      ensureOpenWaBuilt({ force: true })
      break
    default:
      console.error('usage: node scripts/wacrm.mjs dev|start|build|cron|openwa:install|openwa:build [args]')
      process.exit(2)
  }
}

// Run only as a script: tests import the scheduler functions.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2)
  try {
    await main(cmd, rest)
  } catch (err) {
    console.error(`[wacrm] ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
