import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const origin = `http://127.0.0.1:${fixture.port}`;
const profile = mkdtempSync('/tmp/opencode/context-observe-browser-');
const extensionDir = `${profile}/extension`;
cpSync(resolve('extension/dist'), extensionDir, { recursive: true });
const manifest = JSON.parse(readFileSync(`${extensionDir}/manifest.json`, 'utf8'));
// Chrome headless cannot interact with permission prompts; grant only this synthetic loopback origin in the fixture.
manifest.host_permissions = [`${origin}/*`];
writeFileSync(`${extensionDir}/manifest.json`, JSON.stringify(manifest));
let context;
const failures = [];
const detailQueries = [];
const api = async (path, method = 'GET', body) => {
  const url = new URL(path, origin); url.searchParams.set('location[directory]', fixture.project);
  const res = await fetch(url, { method, headers: { authorization: `Basic ${Buffer.from(`opencode:${fixture.password}`).toString('base64')}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert(res.ok, `${path}: ${res.status}`); const text = await res.text(); return text ? JSON.parse(text) : null;
};
try {
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROME_BINARY ?? 'google-chrome', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', '--enable-unsafe-extension-debugging'], viewport: { width: 1440, height: 960 } });
  const cdp = await context.browser().newBrowserCDPSession();
  const extension = await cdp.send('Extensions.loadUnpacked', { path: extensionDir });
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => {
    if (request.url().includes('/api/rpc/o3p.context.observe/detail')) detailQueries.push(request.postDataJSON()?.input?.full);
  });
  const paired = await api('/api/pair', 'POST');
  await page.goto(`${origin}/auth/connect/${paired.code}`);
  await page.waitForLoadState('domcontentloaded');
  const cookieStatus = await page.evaluate(async () => (await fetch('/api/info')).status);
  assert.equal(cookieStatus, 200);
  const title = await page.title();
  const popup = await context.newPage();
  // A headless extension page stands in for the toolbar popup. All scripting/fetch APIs remain real.
  await popup.addInitScript(({ origin }) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async () => (await query({})).filter(tab => tab.url?.startsWith(origin));
  }, { origin });
  await popup.goto(`chrome-extension://${extension.id}/popup.html`);
  console.log(JSON.stringify({ nativePageTitle: title, popupOrigin: await popup.locator('#origin').textContent() }));
  await popup.locator('#attach').click();
  await page.locator('#o3p-context-observe-host').waitFor({ state: 'attached', timeout: 20000 });
  await page.getByRole('button', { name: 'CTX', exact: true }).click();
  await page.locator('#o3p-context-observe-host .row.selected').waitFor();
  await page.locator('#o3p-context-observe-host .row').filter({ hasText: '#2 ' }).click();
  await page.getByRole('button', { name: '2 原始', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#o3p-context-observe-host')?.shadowRoot?.querySelector('.detail')?.textContent?.includes('SYNTHETIC_SECOND'));
  assert((await page.locator('#o3p-context-observe-host .detail').textContent()).includes('SYNTHETIC_FIRST'));
  await page.getByRole('button', { name: '1 增量', exact: true }).click();
  const delta = await page.locator('#o3p-context-observe-host .detail').textContent();
  assert(delta.includes('SYNTHETIC_SECOND')); assert(!delta.includes('SYNTHETIC_FIRST'));
  await page.getByPlaceholder('搜索当前视图').fill('SYNTHETIC_SECOND');
  assert.equal(await page.locator('#o3p-context-observe-host mark').count(), 1);
  await page.getByPlaceholder('搜索当前视图').fill('');
  await page.getByRole('button', { name: '跟随', exact: true }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await api(`/api/session/${fixture.sessionID}/prompt`, 'POST', { text: 'SYNTHETIC_WHILE_PAUSED' });
  await api(`/api/experimental/session/${fixture.sessionID}/wait`, 'POST');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#o3p-context-observe-host')?.shadowRoot?.querySelector('.detail')?.textContent?.includes('SYNTHETIC_WHILE_PAUSED'));
  const downloadWait = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const download = await downloadWait;
  assert(download.suggestedFilename().endsWith('.json'));
  // A separate fixture producer edits the system prefix without reloading the observer.
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const submit = async text => { await api(`/api/session/${fixture.sessionID}/prompt`, 'POST', { text }); await api(`/api/experimental/session/${fixture.sessionID}/wait`, 'POST'); };
  writeFileSync(fixture.prefixFile, 'PREFIX_ORIGINAL');
  await submit('SYNTHETIC_PREFIX_BASELINE');
  writeFileSync(fixture.prefixFile, 'PREFIX_CHANGED');
  await submit('SYNTHETIC_PREFIX_REBUILD');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#o3p-context-observe-host')?.shadowRoot?.querySelector('.banner')?.textContent?.includes('前缀已变，缓存可能掉'));
  await page.waitForFunction(() => document.querySelector('#o3p-context-observe-host')?.shadowRoot?.querySelector('.detail')?.textContent?.includes('PREFIX_CHANGED'));
  assert((await page.locator('#o3p-context-observe-host .views button.current').textContent()).includes('逻辑'));
  await page.getByRole('button', { name: '4 差异', exact: true }).click();
  assert((await page.locator('#o3p-context-observe-host .detail').textContent()).includes('PREFIX_CHANGED'));
  await submit('SYNTHETIC_AFTER_REBUILD');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#o3p-context-observe-host')?.shadowRoot?.querySelector('.detail')?.textContent?.includes('SYNTHETIC_AFTER_REBUILD'));
  assert((await page.locator('#o3p-context-observe-host .views button.current').textContent()).includes('增量'));
  assert(!(await page.locator('#o3p-context-observe-host .detail').textContent()).includes('SYNTHETIC_FIRST'));
  assert(detailQueries.includes(false)); assert(detailQueries.includes(true));
  assert.deepEqual(failures, []);
  if(process.env.QA_SCREENSHOT) await page.screenshot({path:process.env.QA_SCREENSHOT});
  console.log(JSON.stringify({ chrome: context.browser().version(), extensionID: extension.id, loadedActualExtension: true,
    pageCookieAuthentication: true, popupProbeAndInjection: true, rawComplete: true, appendOnlyView: true,
    search: true, pausedCaptureContinues: true, exportedDetail: true, prefixRebuildBanner: true, autoFullLogical: true,
    diffView: true, appendAfterRebuild: true, leanDetailQueries: true, fullOnDemand: true, pageErrors: failures.length,
    headlessPermissionPregranted: true, toolbarPopupNotAutomated: true }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await context?.close(); rmSync(profile, { recursive: true, force: true });
}
