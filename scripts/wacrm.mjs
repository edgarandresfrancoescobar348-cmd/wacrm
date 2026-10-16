#!/usr/bin/env node
// ============================================================
// One start for wacrm and its embedded WhatsApp gateway (OpenWA,
// vendored under packages/openwa).
//
//   node scripts/wacrm.mjs dev   [next dev args]    npm run dev
//   node scripts/wacrm.mjs start [next start args]  npm run start
//   node scripts/wacrm.mjs build [next build args]  npm run build
//   node scripts/wacrm.mjs openwa:install | openwa:build
//
// dev/start run Next and OpenWA side by side; when either exits (or on
// Ctrl-C / SIGTERM) both stop. The gateway's admin API key is a shared
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
// ============================================================

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OPENWA_DIR = path.join(ROOT, 'packages', 'openwa')
const NEXT_BIN = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
const INSTALL_STAMP = path.join(OPENWA_DIR, 'node_modules', '.wacrm-install-stamp')
const KEY_FILE_NAME = 'gateway.key'
const STOP_GRACE_MS = 20_000

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

/** `npm ci` in packages/openwa when its lockfile changed since the last install. */
function ensureOpenWaInstalled({ force = false } = {}) {
  const stamp = sha256File(path.join(OPENWA_DIR, 'package-lock.json'))
  const current = fs.existsSync(INSTALL_STAMP) ? fs.readFileSync(INSTALL_STAMP, 'utf8').trim() : ''
  if (!force && current === stamp) return
  log('installing the WhatsApp gateway dependencies (packages/openwa, first run only)…')
  // npm_config_* from the outer `npm run` would leak into the nested install.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('npm_config_')))
  run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: OPENWA_DIR, env })
  fs.writeFileSync(INSTALL_STAMP, stamp + '\n')
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
function openWaEnv({ mode, port, key }) {
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

  const stopAll = (code) => {
    if (stopping) return
    stopping = true
    process.exitCode = code
    for (const c of children) if (c.exitCode === null) c.kill('SIGTERM')
    setTimeout(() => {
      for (const c of children) if (c.exitCode === null) c.kill('SIGKILL')
    }, STOP_GRACE_MS).unref()
  }

  if (embedded.on) {
    ensureOpenWaInstalled()
    ensureOpenWaBuilt()
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
    nextEnv.OPENWA_WEBHOOK_BASE_URL = `http://127.0.0.1:${port}`
  } else {
    log(`WhatsApp gateway not started: ${embedded.why}. QR-code mode is unavailable; the official API mode works.`)
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
  } else {
    log(`skipping the WhatsApp gateway build: ${embedded.why}`)
  }
  run(process.execPath, [NEXT_BIN, 'build', ...nextArgs], { cwd: ROOT })
}

const [cmd, ...rest] = process.argv.slice(2)
try {
  switch (cmd) {
    case 'dev':
    case 'start':
      await serve(cmd, rest)
      break
    case 'build':
      build(rest)
      break
    case 'openwa:install':
      ensureOpenWaInstalled({ force: true })
      break
    case 'openwa:build':
      ensureOpenWaInstalled()
      ensureOpenWaBuilt({ force: true })
      break
    default:
      console.error('usage: node scripts/wacrm.mjs dev|start|build|openwa:install|openwa:build [args]')
      process.exit(2)
  }
} catch (err) {
  console.error(`[wacrm] ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
