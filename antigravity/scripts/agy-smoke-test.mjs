// Rubato Antigravity plugin — end-to-end offline smoke test (no real broker).
// Spec §10 paradigm adapted to a user-side Antigravity plugin (no estimator §3,
// no local archive §5, no model tool registration §6): hook events drive the
// detached daemon, a realistic Antigravity transcript.jsonl appends (and
// rewrites) PLANNER_RESPONSE records, and a localhost MQTT 3.1.1 broker
// captures real wire traffic (CONNECT clientId, PUBLISH topic and JSON).
//
// Usage: node scripts/agy-smoke-test.mjs
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync,
  appendFileSync, rmSync, mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, CONFIG_NAME } from '../lib/config.mjs'

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log('PASS ' + name)
  else {
    failures += 1
    console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''))
  }
}

async function waitFor(fn, timeoutMs) {
  const end = Date.now() + timeoutMs
  for (;;) {
    let v = null
    try { v = fn() } catch { v = null }
    if (v) return v
    if (Date.now() > end) return null
    await sleep(80)
  }
}

// ---- fake MQTT 3.1.1 broker (localhost, TLS off) ----------------------------
function startFakeBroker(captures) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0)
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d])
        for (;;) {
          if (buf.length < 2) return
          let mult = 1
          let rl = 0
          let i = 1
          let complete = false
          for (; i < buf.length; i += 1) {
            const b = buf[i]
            rl += (b & 127) * mult
            mult *= 128
            if ((b & 128) === 0) { complete = true; i += 1; break }
          }
          if (!complete || buf.length < i + rl) return
          const pkt = buf.subarray(0, i + rl)
          buf = buf.subarray(i + rl)
          const type = pkt[0] >> 4
          if (type === 1) { // CONNECT
            let p = 2
            const plen = pkt.readUInt16BE(p); p += 2 + plen + 4
            const clen = pkt.readUInt16BE(p); p += 2
            captures.clientIds.push(pkt.toString('utf8', p, p + clen))
            sock.write(Buffer.from([0x20, 0x02, 0x00, 0x00]))
          } else if (type === 3) { // PUBLISH
            let p = 2
            const tlen = pkt.readUInt16BE(p); p += 2
            const topic = pkt.toString('utf8', p, p + tlen); p += tlen
            let msgId = 0
            if ((pkt[0] & 0x06) === 0x02) { msgId = pkt.readUInt16BE(p); p += 2 }
            let payload = null
            try { payload = JSON.parse(pkt.toString('utf8', p, i + rl)) } catch { payload = null }
            captures.publishes.push({ topic, payload })
            if (msgId) sock.write(Buffer.from([0x40, 0x02, msgId >> 8, msgId & 0xff]))
          } else if (type === 12) { // PINGREQ
            sock.write(Buffer.from([0xd0, 0x00]))
          }
        }
      })
      sock.on('error', () => { /* expected on daemon kill */ })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const captures = { publishes: [], clientIds: [] }
const broker = await startFakeBroker(captures)
const port = broker.address().port

const dataDir = mkdtempSync(join(tmpdir(), 'rubato-agy-smoke-'))
const workspaceDir = join(dataDir, 'workspace')
const queueDir = join(dataDir, 'queue')
mkdirSync(workspaceDir, { recursive: true })

// Written under LEGACY name with a // comment line (spec §4 / §10) — daemon
// must migrate it in place to rubato-mqtt-config.json on first load.
writeFileSync(join(dataDir, 'agy-mqtt-config.json'), `// smoke test config
{
  "enabled": true,
  "username": "RUBATO-000000",
  "password": "placeholder-token",
  "host": "127.0.0.1",
  "port": ${port},
  "tls": false
}`, 'utf8')

// Realistic Antigravity transcript.jsonl with one completed prior turn
// (so tailModel resolves the concrete model when hook reports modelName='auto').
const transcriptPath = join(dataDir, 'transcript.jsonl')
const MODEL = 'gemini-4-hydrogen-xhigh'
const plannerLine = (stepIdx, opts) => JSON.stringify({
  step_index: stepIdx,
  source: 'MODEL',
  type: 'PLANNER_RESPONSE',
  status: 'DONE',
  created_at: new Date().toISOString(),
  model: MODEL,
  input_tokens: 100,
  cache_read_tokens: 0,
  output_tokens: 42,
  thinking: 'reasoning...',
  ...(opts.toolCalls ? { tool_calls: opts.toolCalls } : {}),
  ...(opts.content ? { content: opts.content } : {}),
})
appendFileSync(transcriptPath, JSON.stringify({
  step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'earlier',
}) + '\n')
appendFileSync(transcriptPath, plannerLine(1, { content: 'done earlier' }) + '\n')
appendFileSync(transcriptPath, JSON.stringify({
  step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Refactor widget',
}) + '\n')

let seq = 0
function enqueue(payload) {
  mkdirSync(queueDir, { recursive: true })
  seq += 1
  const ts = String(Date.now()).padStart(15, '0')
  const n = String(seq).padStart(6, '0')
  writeFileSync(join(queueDir, `${ts}-${n}.json`), JSON.stringify(payload), 'utf8')
}

const wire = () => captures.publishes.map((p) => p.payload)
const wireStates = () => wire().map((r) => r.state)
const countState = (s) => wire().filter((r) => r.state === s).length

let daemon = null
function startDaemon() {
  daemon = spawn(process.execPath, [join(PLUGIN_ROOT, 'lib', 'daemon.mjs')], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, RUBATO_DATA_DIR: dataDir },
  })
  return daemon
}
function killHard() {
  if (daemon && daemon.pid) { try { daemon.kill('SIGKILL') } catch { /* ignore */ } }
  daemon = null
}

try {
  // ---- Phase 0: legacy config migration & // comment tolerance --------------
  startDaemon()
  await waitFor(() => existsSync(join(dataDir, CONFIG_NAME)), 8000)
  check(
    'Legacy agy-mqtt-config.json migrated to rubato-mqtt-config.json',
    existsSync(join(dataDir, CONFIG_NAME)) && !existsSync(join(dataDir, 'agy-mqtt-config.json')),
  )

  // ---- Phase A: multi-step tool loop + lean Done ----------------------------
  enqueue({
    type: 'pre-invocation',
    conversationId: 'c1',
    transcriptPath,
    modelName: 'auto',
    cwd: workspaceDir,
    invocationNum: 1,
    initialNumSteps: 2,
    lastUserInput: 'Refactor widget',
  })
  const est1 = await waitFor(() => wire().find((r) => r.state === 'Estimate'), 8000)
  check('Estimate without estSec (§3 dsh-only)', Boolean(est1 && !('estSec' in est1) && est1.model === MODEL), est1)
  const think1 = await waitFor(() => wire().find((r) => r.state === 'Thinking'), 8000)
  check('Thinking published at PreInvocation (§2.4.2)', Boolean(think1 && think1.model === MODEL), think1)

  await sleep(150)
  appendFileSync(transcriptPath, plannerLine(3, {
    toolCalls: [{ name: 'read_file', args: { Path: 'a.js' } }],
  }) + '\n')
  const gen1 = await waitFor(() => wire().find((r) => r.state === 'Generating'), 8000)
  check('Generating on PLANNER_RESPONSE tool_calls', Boolean(gen1 && gen1.model === MODEL), gen1)

  enqueue({ type: 'post-tool-use', conversationId: 'c1', transcriptPath, modelName: 'auto', cwd: workspaceDir, toolName: 'read_file', stepIdx: 4 })
  enqueue({ type: 'post-invocation', conversationId: 'c1', transcriptPath, modelName: 'auto', cwd: workspaceDir, invocationNum: 1, initialNumSteps: 2 })
  await sleep(1700)
  check('No intermediate Done after tool-calls step (§2.4.3)', countState('Done') === 0, wireStates())

  enqueue({
    type: 'pre-invocation',
    conversationId: 'c1',
    transcriptPath,
    modelName: 'auto',
    cwd: workspaceDir,
    invocationNum: 2,
    initialNumSteps: 2,
    lastUserInput: 'Refactor widget',
  })
  await waitFor(() => countState('Estimate') >= 2 && countState('Thinking') >= 2, 8000)

  await sleep(150)
  appendFileSync(transcriptPath, plannerLine(5, { content: 'Widget refactored.' }) + '\n')
  await waitFor(() => countState('Generating') >= 2, 8000)
  enqueue({ type: 'post-invocation', conversationId: 'c1', transcriptPath, modelName: 'auto', cwd: workspaceDir, invocationNum: 2, initialNumSteps: 2 })
  enqueue({ type: 'stop', conversationId: 'c1', transcriptPath, modelName: 'auto', cwd: workspaceDir, terminationReason: 'NO_TOOL_CALL', error: '' })

  const done1 = await waitFor(() => wire().find((r) => r.state === 'Done'), 8000)
  check(
    'Lean Done without tokens/est/dur (§2.4.5)',
    Boolean(done1 && JSON.stringify(Object.keys(done1).sort()) === JSON.stringify(['model', 'state', 'ts'])),
    done1,
  )
  check('clientId = AGY-RUBATO-000000 (§2.2)', captures.clientIds.includes('AGY-RUBATO-000000'), captures.clientIds)
  check(
    'topic = rubato/<username>/state',
    captures.publishes.every((p) => p.topic === 'rubato/RUBATO-000000/state'),
    captures.publishes[0] && captures.publishes[0].topic,
  )

  // ---- Phase A2: user-side zero-disk discipline (§5) ------------------------
  check('No records archive on user-side plugin', !existsSync(join(dataDir, 'rubato-records.jsonl')))
  check('No stats/calibration file on user-side plugin', !existsSync(join(dataDir, 'rubato-stats.json')))

  // ---- Phase A3: USER_CANCELED, ERROR, abandoned turn, debounce, rewrite ----
  enqueue({ type: 'pre-invocation', conversationId: 'c1', transcriptPath, modelName: MODEL, cwd: workspaceDir, invocationNum: 1, initialNumSteps: 6, lastUserInput: 'Turn 2' })
  await waitFor(() => countState('Estimate') >= 3, 8000)
  enqueue({ type: 'stop', conversationId: 'c1', transcriptPath, modelName: MODEL, cwd: workspaceDir, terminationReason: 'USER_CANCELED', error: '' })
  await waitFor(() => countState('Done') >= 2, 8000)

  enqueue({ type: 'pre-invocation', conversationId: 'c1', transcriptPath, modelName: MODEL, cwd: workspaceDir, invocationNum: 1, initialNumSteps: 7, lastUserInput: 'Turn 3' })
  await waitFor(() => countState('Estimate') >= 4, 8000)
  enqueue({ type: 'stop', conversationId: 'c1', transcriptPath, modelName: MODEL, cwd: workspaceDir, terminationReason: 'ERROR', error: 'rate_limit' })
  await waitFor(() => countState('Error') >= 1 && countState('Done') >= 3, 8000)
  const errMsg = wire().find((r) => r.state === 'Error')
  check('Error carries error field', Boolean(errMsg && errMsg.error === 'rate_limit'), errMsg)

  enqueue({ type: 'pre-invocation', conversationId: 'c1', transcriptPath, modelName: MODEL, cwd: workspaceDir, invocationNum: 1, initialNumSteps: 8, lastUserInput: 'Turn 4' })
  await waitFor(() => countState('Estimate') >= 5, 8000)
  enqueue({ type: 'pre-invocation', conversationId: 'c1', transcriptPath, modelName: MODEL, cwd: workspaceDir, invocationNum: 1, initialNumSteps: 9, lastUserInput: 'Turn 5' })
  await waitFor(() => countState('Estimate') >= 6, 8000)
  enqueue({ type: 'stop', conversationId: 'c1', transcriptPath, modelName: MODEL, cwd: workspaceDir, terminationReason: 'NO_TOOL_CALL', error: '' })
  await waitFor(() => countState('Done') >= 5, 8000)

  enqueue({ type: 'pre-invocation', conversationId: 'c1', transcriptPath, modelName: MODEL, cwd: workspaceDir, invocationNum: 1, initialNumSteps: 10, lastUserInput: 'Turn 6' })
  await waitFor(() => countState('Estimate') >= 7, 8000)
  const oldLines = readFileSync(transcriptPath, 'utf8').trim().split('\n')
  oldLines[0] = JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'e' })
  oldLines.push(plannerLine(11, { content: 'Rewritten transcript answer.' }))
  writeFileSync(transcriptPath, oldLines.join('\n') + '\n', 'utf8')
  await waitFor(() => countState('Generating') >= 3, 8000)
  enqueue({ type: 'post-invocation', conversationId: 'c1', transcriptPath, modelName: MODEL, cwd: workspaceDir, invocationNum: 1, initialNumSteps: 10 })
  await waitFor(() => countState('Done') >= 6, 8000)
  check('Transcript rewrite detected and PostInvocation debounced Done fires', countState('Generating') >= 3 && countState('Done') >= 6)

  const expectedSeq = [
    'Estimate', 'Thinking', 'Generating',
    'Estimate', 'Thinking', 'Generating', 'Done',
    'Estimate', 'Thinking', 'Done',
    'Estimate', 'Thinking', 'Error', 'Done',
    'Estimate', 'Thinking', 'Done',
    'Estimate', 'Thinking', 'Done',
    'Estimate', 'Thinking', 'Generating', 'Done',
  ].join(',')
  check('Full sequence E,T,G,E,T,G,D | E,T,D | E,T,Err,D | E,T,D | E,T,D | E,T,G,D', wireStates().join(',') === expectedSeq, wireStates())

  // ---- Phase B: stale-lock recovery -----------------------------------------
  killHard()
  await sleep(200)
  check('Lock file left behind by hard kill', existsSync(join(dataDir, 'daemon.lock')))
  startDaemon()
  enqueue({ type: 'pre-invocation', conversationId: 'c1', transcriptPath, modelName: MODEL, cwd: workspaceDir, invocationNum: 1, initialNumSteps: 12, lastUserInput: 'post-restart' })
  enqueue({ type: 'stop', conversationId: 'c1', transcriptPath, modelName: MODEL, cwd: workspaceDir, terminationReason: 'NO_TOOL_CALL' })
  await waitFor(() => countState('Done') >= 7, 8000)
  check('New daemon breaks stale lock and serves queue', countState('Done') >= 7)

  // ---- Phase C: real hook.mjs via hooks.json relative cmd from PLUGIN_ROOT --
  killHard()
  await sleep(200)
  const hooksJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks.json'), 'utf8'))
  const preCmd = hooksJson.rubato.PreInvocation[0].command
  const stopCmd = hooksJson.rubato.Stop[0].command
  const shellFlag = process.platform === 'win32' ? { shell: 'cmd.exe' } : { shell: '/bin/sh' }

  const preHookInput = JSON.stringify({
    conversationId: 'c2',
    transcriptPath,
    cwd: workspaceDir,
    modelName: MODEL,
    hookEventName: 'PreInvocation',
    invocationNum: 1,
    initialNumSteps: 13,
    lastUserInput: 'Real hook turn',
  })
  const hPre = spawnSync(preCmd, {
    cwd: PLUGIN_ROOT,
    input: preHookInput,
    env: { ...process.env, RUBATO_DATA_DIR: dataDir },
    encoding: 'utf8',
    ...shellFlag,
  })
  check(
    'hooks.json PreInvocation command exits 0 with {} when configured',
    hPre.status === 0 && hPre.stdout.trim() === '{}',
    { status: hPre.status, out: hPre.stdout, err: hPre.stderr },
  )
  await waitFor(() => countState('Estimate') >= 9, 15000)
  check('Hook-spawned daemon processes PreInvocation', countState('Estimate') >= 9)

  const stopHookInput = JSON.stringify({
    conversationId: 'c2',
    transcriptPath,
    cwd: workspaceDir,
    modelName: MODEL,
    hookEventName: 'Stop',
    terminationReason: 'NO_TOOL_CALL',
    error: '',
  })
  const hStop = spawnSync(stopCmd, {
    cwd: PLUGIN_ROOT,
    input: stopHookInput,
    env: { ...process.env, RUBATO_DATA_DIR: dataDir },
    encoding: 'utf8',
    ...shellFlag,
  })
  check(
    'hooks.json Stop command exits 0 with {"decision":"allow"}',
    hStop.status === 0 && hStop.stdout.trim() === '{"decision":"allow"}',
    { status: hStop.status, out: hStop.stdout },
  )
  await waitFor(() => countState('Done') >= 8, 8000)
  check('Hook Stop finalizes turn with Done', countState('Done') >= 8)

  // ---- Phase E: CLI status helper -------------------------------------------
  const stRes = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'status.mjs'), workspaceDir], {
    env: { ...process.env, RUBATO_DATA_DIR: dataDir },
    encoding: 'utf8',
  })
  let stJson = null
  try { stJson = JSON.parse(stRes.stdout) } catch { stJson = null }
  check(
    'scripts/status.mjs reports masked config and running daemon',
    Boolean(
      stRes.status === 0
      && stJson
      && stJson.configured === true
      && stJson.clientId === 'AGY-RUBATO-000000'
      && stJson.usernameMasked === 'RUB***'
      && stJson.daemon && stJson.daemon.running === true
    ),
    stJson,
  )

  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8'))
    if (doc.pid) process.kill(doc.pid, 'SIGKILL')
  } catch { /* ignore */ }
} finally {
  killHard()
  broker.close()
}

// ---- Phase D: first-run SETUP REQUIRED notice + clean template (no BOM) -----
{
  const fresh = mkdtempSync(join(tmpdir(), 'rubato-agy-setup-'))
  try {
    const stdinJson = JSON.stringify({
      conversationId: 'c9',
      cwd: fresh,
      hookEventName: 'PreInvocation',
      invocationNum: 1,
      initialNumSteps: 0,
      lastUserInput: 'hi',
    })
    const hook = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'hooks', 'hook.mjs'), 'pre-invocation'], {
      input: stdinJson,
      env: { ...process.env, RUBATO_DATA_DIR: fresh },
      encoding: 'utf8',
    })
    let out = null
    try { out = JSON.parse(hook.stdout.trim()) } catch { out = null }
    const step = out && Array.isArray(out.injectSteps) && out.injectSteps[0] && out.injectSteps[0].systemMessage
    check(
      'First-run SETUP notice shown once via user_markdown with empty systemMessage',
      Boolean(step && step.systemMessage === '' && step.metadata && step.metadata.user_markdown.includes('SETUP REQUIRED')),
      out,
    )

    const tplPath = join(fresh, CONFIG_NAME)
    const rawTpl = existsSync(tplPath) ? readFileSync(tplPath) : null
    const hasBom = Boolean(rawTpl && rawTpl.length >= 3 && rawTpl[0] === 0xef && rawTpl[1] === 0xbb && rawTpl[2] === 0xbf)
    let parsedTpl = null
    try { parsedTpl = rawTpl ? JSON.parse(rawTpl.toString('utf8')) : null } catch { parsedTpl = null }
    check(
      'Config template created as pure JSON without BOM or comments',
      Boolean(rawTpl && !hasBom && parsedTpl && parsedTpl.username === '' && parsedTpl.password === ''),
    )
    check('Setup marker prevents repeat notice', existsSync(join(fresh, '.setup-shown')))

    const hook2 = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'hooks', 'hook.mjs'), 'pre-invocation'], {
      input: stdinJson,
      env: { ...process.env, RUBATO_DATA_DIR: fresh },
      encoding: 'utf8',
    })
    check('Notice not repeated on next PreInvocation', hook2.stdout.trim() === '{}', hook2.stdout)

    try {
      const doc = JSON.parse(readFileSync(join(fresh, 'daemon.json'), 'utf8'))
      if (doc.pid) process.kill(doc.pid, 'SIGKILL')
    } catch { /* ignore */ }
  } finally {
    try { rmSync(fresh, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ---- Phase F: cwd-first lookup & dsh-mqtt-config.json migration (no override)
{
  const root = mkdtempSync(join(tmpdir(), 'rubato-agy-cwd-'))
  const ws = join(root, 'ws')
  const pdata = join(root, 'pdata')
  mkdirSync(ws, { recursive: true })
  mkdirSync(pdata, { recursive: true })
  writeFileSync(join(pdata, CONFIG_NAME), JSON.stringify({ username: 'RUBATO-111111', password: 'p1' }))
  writeFileSync(join(ws, 'dsh-mqtt-config.json'), JSON.stringify({ username: 'RUBATO-222222', password: 'p2' }))
  const prevOverride = process.env.RUBATO_DATA_DIR
  const prevPdata = process.env.PLUGIN_DATA
  delete process.env.RUBATO_DATA_DIR
  process.env.PLUGIN_DATA = pdata
  try {
    const cfg = loadConfig(ws)
    check(
      'Workspace cwd wins over PLUGIN_DATA and migrates dsh-mqtt-config.json',
      cfg.username === 'RUBATO-222222'
      && cfg.clientId === 'AGY-RUBATO-222222'
      && existsSync(join(ws, CONFIG_NAME))
      && !existsSync(join(ws, 'dsh-mqtt-config.json')),
      cfg,
    )
  } finally {
    if (prevOverride !== undefined) process.env.RUBATO_DATA_DIR = prevOverride
    if (prevPdata !== undefined) process.env.PLUGIN_DATA = prevPdata
    else delete process.env.PLUGIN_DATA
    try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(failures === 0 ? '\nSMOKE TEST PASSED' : '\nSMOKE TEST FAILED: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
