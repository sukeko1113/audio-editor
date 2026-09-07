// 音声編集アプリ（Electron）を headless Linux 上で起動して操作するための REPL ドライバ。
//
// tmux 内で起動し、send-keys でコマンドを送って capture-pane で結果を読む想定。
// 起動は数秒かかるので、操作のたびに立ち上げ直さずに済む REPL の形にしている。
//
// このアプリはファイル選択・保存に Electron のネイティブダイアログを使う。
// headless では人が操作できないため、stub-open / stub-save でメインプロセスの
// dialog.showOpenDialog / showSaveDialog を差し替えてから操作する。
import { _electron as electron } from 'playwright-core'
import * as readline from 'node:readline'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// .claude/skills/run-desktop/driver.mjs → リポジトリのルート
// （import.meta.dirname は Node 20.11+ 限定なので URL から求める）
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/shots'
fs.mkdirSync(SHOT_DIR, { recursive: true })

let app = null
let page = null

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched')
    // package.json の main は out/main/index.js。ビルドしていないと真っ白な窓が出る。
    if (!fs.existsSync(path.join(APP_DIR, 'out/main/index.js'))) {
      return console.log('ERROR: out/ がありません。先に `npm run build` を実行してください')
    }
    app = await electron.launch({
      executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
      // コンテナには CAP_SYS_ADMIN が無いので Electron のサンドボックスは無効にする
      args: ['--no-sandbox', APP_DIR],
      cwd: APP_DIR,
      timeout: 45_000
    })
    page = await app.firstWindow()
    await page.waitForSelector('#open-file-btn', { timeout: 20_000 })
    console.log('launched. windows:', app.windows().length, '|', await page.title())
  },

  // 次に開くファイル選択ダイアログが返すパスを固定する（空白区切りで複数可・空でキャンセル）
  async 'stub-open'(paths) {
    if (!app) return console.log('ERROR: launch first')
    const filePaths = paths.split(/\s+/).filter(Boolean)
    await app.evaluate(({ dialog }, list) => {
      dialog.showOpenDialog = async () => ({ canceled: list.length === 0, filePaths: list })
    }, filePaths)
    console.log('stub-open ->', JSON.stringify(filePaths))
  },

  // 次に開く保存ダイアログが返すパスを固定する（空でキャンセル）
  async 'stub-save'(p) {
    if (!app) return console.log('ERROR: launch first')
    const filePath = p.trim()
    await app.evaluate(({ dialog }, out) => {
      dialog.showSaveDialog = async () => ({ canceled: !out, filePath: out })
    }, filePath)
    console.log('stub-save ->', JSON.stringify(filePath))
  },

  // ダイアログに渡された引数（対応形式のフィルタ、既定のファイル名）を記録する。
  // 「いま入っている実装」を包む作りなので、stub-open / stub-save より
  // 「あと」に実行すること。先に実行すると stub に上書きされて記録が残らない。
  async 'spy-dialogs'() {
    if (!app) return console.log('ERROR: launch first')
    await app.evaluate(({ dialog }) => {
      global.__dialogCalls = []
      const open = dialog.showOpenDialog
      const save = dialog.showSaveDialog
      dialog.showOpenDialog = async (opts) => {
        global.__dialogCalls.push({ kind: 'open', title: opts.title, properties: opts.properties, filters: opts.filters })
        return open.call(dialog, opts)
      }
      dialog.showSaveDialog = async (opts) => {
        global.__dialogCalls.push({ kind: 'save', title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters })
        return save.call(dialog, opts)
      }
    })
    console.log('spying on dialogs')
  },

  async 'dialog-log'() {
    if (!app) return console.log('ERROR: launch first')
    console.log(JSON.stringify(await app.evaluate(() => global.__dialogCalls || []), null, 1))
  },

  async ss(name) {
    if (!page) return console.log('ERROR: launch first')
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png')
    await page.screenshot({ path: f })
    console.log('screenshot:', f)
  },

  // 座標ではなく DOM の click() を使う（disabled なボタンを押したときに気づけるよう戻り値で返す）
  async click(sel) {
    if (!page) return console.log('ERROR: launch first')
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s)
      if (!el) return 'NOT_FOUND'
      if (el.disabled) return 'DISABLED'
      el.click()
      return 'OK'
    }, sel)
    console.log('click', sel, '->', r)
  },

  async wait(sel) {
    if (!page) return console.log('ERROR: launch first')
    try { await page.waitForSelector(sel, { timeout: 30_000 }); console.log('found:', sel) }
    catch { console.log('TIMEOUT:', sel) }
  },

  // 読み込み・カット・結合・保存はどれも ffmpeg を回すので数秒〜数分かかる。
  // 完了はステータス行に出るため、そこに指定の文字列が現れるまで待つ。
  async 'wait-status'(text) {
    if (!page) return console.log('ERROR: launch first')
    const now = () => page.evaluate(() => document.getElementById('status').textContent)
    try {
      await page.waitForFunction(
        (t) => (document.getElementById('status')?.textContent || '').includes(t),
        text, { timeout: 180_000 }
      )
      console.log('status:', await now())
    } catch {
      console.log('TIMEOUT waiting for status:', text, '| now:', await now())
    }
  },

  async eval(expr) {
    if (!page) return console.log('ERROR: launch first')
    try { console.log(JSON.stringify(await page.evaluate(expr))) }
    catch (e) { console.log('ERROR:', e.message) }
  },

  async text(sel) {
    if (!page) return console.log('ERROR: launch first')
    console.log(await page.evaluate(
      (s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null))
  },

  async quit() { if (app) await app.close().catch(() => {}); app = null; page = null },
  help() { console.log('commands:', Object.keys(COMMANDS).join(', ')) }
}

// Electron に stdin を奪われるため、生の fd から読む
const stdin = fs.createReadStream(null, { fd: fs.openSync('/dev/stdin', 'r') })
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' })

rl.on('line', async (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/)
  if (!cmd) return rl.prompt()
  const fn = COMMANDS[cmd]
  if (!fn) { console.log('unknown:', cmd, '- try: help'); return rl.prompt() }
  try { await fn(rest.join(' ')) } catch (e) { console.log('ERROR:', e.message) }
  if (cmd === 'quit') { rl.close(); process.exit(0) }
  rl.prompt()
})
rl.on('close', async () => { await COMMANDS.quit(); process.exit(0) })

console.log('audio-editor driver - "help" for commands, "launch" to start')
rl.prompt()
