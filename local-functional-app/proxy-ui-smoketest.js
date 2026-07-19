const cdp = require('./cdp');

async function evaluate(expression, awaitPromise = false) {
  const tab = (await cdp.tabs(9333))[0];
  if (!tab) throw new Error('OpenBrowser renderer is not available on port 9333');
  const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

async function main() {
  const action = process.argv[2] || 'inspect'; const id = process.argv[3] || 'env-001';
  if (action === 'inspect') {
    const value = await evaluate(`(() => {
      const ui = JSON.parse(localStorage.getItem('openbrowser-ui-state') || '{}');
      return (ui.profiles || []).map((profile) => ({
        id: profile.id,
        mode: /^(direct|offline|none)$/i.test(String(profile.proxy || '')) ? 'Direct' : String(profile.proxy || '').split(':')[0].toUpperCase(),
        endpoint: (() => { try { const value = new URL(profile.proxy); return value.hostname + ':' + value.port; } catch (_) { return ''; } })(),
        hasCredentials: String(profile.proxy || '').includes('@'),
        exitIp: profile.exitIp || '', country: profile.exitCountryCode || ''
      }));
    })()`);
    console.log(JSON.stringify(value)); return;
  }
  if (action === 'test') {
    const started = await evaluate(`(() => {
      const ui = JSON.parse(localStorage.getItem('openbrowser-ui-state') || '{}'); const profile = (ui.profiles || []).find((item) => item.id === ${JSON.stringify(id)});
      if (!profile) return { status: 'missing' }; window.__proxySmoke = { status: 'running' };
      window.ops.testProfileProxy(profile).then((result) => { window.__proxySmoke = { status: 'ok', ip: result.ip, country: result.countryCode }; }).catch((error) => { window.__proxySmoke = { status: 'error', message: error.message }; });
      return { status: 'started', mode: /^(direct|offline|none)$/i.test(String(profile.proxy || '')) ? 'Direct' : String(profile.proxy || '').split(':')[0].toUpperCase() };
    })()`);
    console.log(JSON.stringify(started)); return;
  }
  if (action === 'result') { console.log(JSON.stringify(await evaluate('(() => { const s = window.__proxySmoke || { status: "idle" }; return { status: s.status, ip: s.ip || "", country: s.country || "", message: s.message || "" }; })()'))); return; }
  if (action === 'test-endpoint') {
    const host = process.argv[4]; const port = Number(process.argv[5]); if (!host || !Number.isInteger(port)) throw new Error('Host and port are required');
    console.log(JSON.stringify(await evaluate(`(() => {
      const ui = JSON.parse(localStorage.getItem('openbrowser-ui-state') || '{}'); const profile = (ui.profiles || []).find((item) => item.id === ${JSON.stringify(id)});
      if (!profile) return { status: 'missing' }; const candidate = new URL(profile.proxy); candidate.hostname = ${JSON.stringify(host)}; candidate.port = ${JSON.stringify(String(port))}; candidate.protocol = 'socks5:';
      window.__proxySmoke = { status: 'running' }; window.ops.testProfileProxy({ ...profile, proxy: candidate.toString() }).then((result) => { window.__proxySmoke = { status: 'ok', ip: result.ip, country: result.countryCode, checkedAt: result.checkedAt, proxy: candidate.toString() }; }).catch((error) => { window.__proxySmoke = { status: 'error', message: error.message }; });
      return { status: 'started', mode: 'SOCKS5', endpoint: candidate.hostname + ':' + candidate.port };
    })()`))); return;
  }
  if (action === 'apply-tested') {
    console.log(JSON.stringify(await evaluate(`(async () => {
      const smoke = window.__proxySmoke; if (!smoke || smoke.status !== 'ok') return { status: smoke?.status || 'idle' };
      const ui = JSON.parse(localStorage.getItem('openbrowser-ui-state') || '{}'); const profile = (ui.profiles || []).find((item) => item.id === ${JSON.stringify(id)}); if (!profile) return { status: 'missing' };
      profile.proxy = smoke.proxy; profile.exitIp = smoke.ip; profile.exitCountryCode = smoke.country; profile.exitCheckedAt = smoke.checkedAt; localStorage.setItem('openbrowser-ui-state', JSON.stringify(ui)); await window.ops.syncProfiles(ui.profiles);
      return { status: 'applied', ip: smoke.ip, country: smoke.country };
    })()`, true))); return;
  }
  if (action === 'start') {
    console.log(JSON.stringify(await evaluate(`(() => {
      const ui = JSON.parse(localStorage.getItem('openbrowser-ui-state') || '{}'); const profile = (ui.profiles || []).find((item) => item.id === ${JSON.stringify(id)}); if (!profile) return { status: 'missing' };
      window.__profileStart = { status: 'running' }; window.ops.startProfile(profile).then((result) => { window.__profileStart = { status: 'ok', port: result.port }; }).catch((error) => { window.__profileStart = { status: 'error', message: error.message }; });
      return { status: 'started' };
    })()`))); return;
  }
  if (action === 'status') {
    const values = await evaluate('(async () => await window.ops.profileStatus())()', true);
    const profile = (values || []).find((item) => item.id === id);
    console.log(JSON.stringify(profile ? { id: profile.id, running: profile.running, port: profile.port || 0, exitIp: profile.network?.ip || profile.exitIp || '', country: profile.network?.countryCode || profile.exitCountryCode || '' } : { status: 'missing' }));
    return;
  }
  if (action === 'google') {
    const values = await evaluate('(async () => await window.ops.profileStatus())()', true);
    const profile = (values || []).find((item) => item.id === id);
    if (!profile?.running || !profile.port) throw new Error('Profile is not running');
    const tab = await cdp.newTab(profile.port, 'https://www.google.com/');
    console.log(JSON.stringify({ id, port: profile.port, targetId: tab.id })); return;
  }
  if (action === 'google-result') {
    const values = await evaluate('(async () => await window.ops.profileStatus())()', true);
    const profile = (values || []).find((item) => item.id === id);
    const tab = (await cdp.tabs(profile?.port || 0)).find((item) => item.url.startsWith('https://www.google.com'));
    if (!tab) throw new Error('Google tab was not found');
    const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: '({ title: document.title, text: (document.body?.innerText || "").slice(0, 300), readyState: document.readyState })', returnByValue: true });
    const value = result.result?.value || {};
    console.log(JSON.stringify({ title: value.title, readyState: value.readyState, hasError: /ERR_|This site can.t be reached|\\u65e0\\u6cd5\\u8bbf\\u95ee\\u6b64\\u7f51\\u7ad9/i.test(value.text), hasGoogle: /Google/i.test(value.text) })); return;
  }
  if (action === 'logs') { console.log(JSON.stringify(await evaluate(`(() => { const ui = JSON.parse(localStorage.getItem('openbrowser-ui-state') || '{}'); return (ui.logs || []).slice(0, 12); })()`))); return; }
  if (action === 'stop') { console.log(JSON.stringify(await evaluate(`(async () => await window.ops.stopProfile(${JSON.stringify(id)}))()`, true))); return; }
  if (action === 'submit-tested') {
    console.log(JSON.stringify(await evaluate(`(() => {
      const smoke = window.__proxySmoke; if (!smoke || smoke.status !== 'ok') return { status: smoke?.status || 'idle' };
      const checkbox = [...document.querySelectorAll('[data-profile-select]')].find((item) => item.dataset.profileSelect === ${JSON.stringify(id)}); if (!checkbox) return { status: 'missing' };
      checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      const mode = document.querySelector('#batch-update-network-mode'); mode.value = 'proxy'; mode.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#batch-update-proxy-type').value = 'socks5'; document.querySelector('#batch-proxy-list').value = smoke.proxy; document.querySelector('#restart-running').checked = false;
      const form = document.querySelector('#batch-update-form'); form.requestSubmit(form.querySelector('button.primary[value="default"]'));
      return { status: 'submitted', id: ${JSON.stringify(id)} };
    })()`))); return;
  }
  if (action === 'bulk-test') {
    const endpoints = process.argv.slice(4); if (!endpoints.length) throw new Error('At least one endpoint is required');
    console.log(JSON.stringify(await evaluate(`(() => {
      const endpoints = ${JSON.stringify(endpoints)}; const ui = JSON.parse(localStorage.getItem('openbrowser-ui-state') || '{}'); const profile = (ui.profiles || []).find((item) => item.id === ${JSON.stringify(id)});
      if (!profile) return { status: 'missing' }; const base = new URL(profile.proxy); let next = 0;
      window.__bulkProxy = { status: 'running', total: endpoints.length, completed: 0, results: [] };
      const worker = async () => {
        while (next < endpoints.length) {
          const index = next++; const endpoint = endpoints[index]; const parts = endpoint.split(':'); const candidate = new URL(base.toString()); candidate.hostname = parts[0]; candidate.port = parts[1]; candidate.protocol = 'socks5:';
          try { const result = await window.ops.testProfileProxy({ ...profile, proxy: candidate.toString() }); window.__bulkProxy.results.push({ endpoint, ok: true, ip: result.ip, country: result.countryCode }); }
          catch (error) { window.__bulkProxy.results.push({ endpoint, ok: false, error: error.message }); }
          window.__bulkProxy.completed += 1;
        }
      };
      Promise.all([worker(), worker(), worker()]).then(() => { window.__bulkProxy.status = 'done'; });
      return { status: 'started', total: endpoints.length, concurrency: 3 };
    })()`))); return;
  }
  if (action === 'bulk-result') { console.log(JSON.stringify(await evaluate('window.__bulkProxy || { status: "idle", results: [] }'))); return; }
  if (action === 'submit-endpoint') {
    const host = process.argv[4]; const port = Number(process.argv[5]); if (!host || !Number.isInteger(port)) throw new Error('Host and port are required');
    console.log(JSON.stringify(await evaluate(`(() => {
      const ui = JSON.parse(localStorage.getItem('openbrowser-ui-state') || '{}'); const profile = (ui.profiles || []).find((item) => item.id === ${JSON.stringify(id)}); if (!profile) return { status: 'missing' };
      const candidate = new URL(profile.proxy); candidate.hostname = ${JSON.stringify(host)}; candidate.port = ${JSON.stringify(String(port))}; candidate.protocol = 'socks5:';
      document.querySelectorAll('[data-profile-select]').forEach((item) => { item.checked = item.dataset.profileSelect === ${JSON.stringify(id)}; item.dispatchEvent(new Event('change', { bubbles: true })); });
      const mode = document.querySelector('#batch-update-network-mode'); mode.value = 'proxy'; mode.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#batch-update-proxy-type').value = 'socks5'; document.querySelector('#batch-proxy-list').value = candidate.toString(); document.querySelector('#restart-running').checked = false;
      const form = document.querySelector('#batch-update-form'); form.requestSubmit(form.querySelector('button.primary[value="default"]'));
      return { status: 'submitted', id: ${JSON.stringify(id)}, endpoint: candidate.hostname + ':' + candidate.port };
    })()`))); return;
  }
  if (action === 'start-endpoint') {
    const host = process.argv[4]; const port = Number(process.argv[5]); if (!host || !Number.isInteger(port)) throw new Error('Host and port are required');
    console.log(JSON.stringify(await evaluate(`(() => {
      const ui = JSON.parse(localStorage.getItem('openbrowser-ui-state') || '{}'); const source = (ui.profiles || []).find((item) => item.id === ${JSON.stringify(id)}); if (!source) return { status: 'missing' };
      const candidate = new URL(source.proxy); candidate.hostname = ${JSON.stringify(host)}; candidate.port = ${JSON.stringify(String(port))}; candidate.protocol = 'socks5:'; const profile = { ...source, id: 'env-proxy-probe', name: 'Proxy Browser Probe', proxy: candidate.toString() };
      window.ops.startProfile(profile).catch(() => {});
      return { status: 'started', id: profile.id, endpoint: candidate.hostname + ':' + candidate.port };
    })()`))); return;
  }
  if (action === 'ui-mode') { console.log(JSON.stringify(await evaluate(`(() => { const select = document.querySelector('#batch-update-network-mode'); const values = [...select.options].map((option) => option.value); select.value = 'direct'; select.dispatchEvent(new Event('change', { bubbles: true })); const direct = { textareaDisabled: document.querySelector('#batch-proxy-list').disabled, submit: document.querySelector('#batch-update-form button.primary[value="default"]').textContent }; select.value = 'proxy'; select.dispatchEvent(new Event('change', { bubbles: true })); return { values, direct }; })()`))); return; }
  throw new Error('Unknown action');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
