const cdp = require('./cdp');

async function main() {
  const tab = (await cdp.tabs(9333))[0];
  if (!tab) throw new Error('OpenBrowser 渲染页面未连接到 9333');
  const expression = `(() => {
    const nav = document.querySelector('[data-view="sync"]');
    nav?.click();
    const health = document.querySelector('#sync-health');
    const group = document.querySelector('#sync-group');
    const start = document.querySelector('#start-sync');
    const editor = document.querySelector('#view-profile-editor');
    return {
      syncView: document.querySelector('#view-sync')?.classList.contains('active') || false,
      health: health?.textContent || '',
      group: group?.options?.[0]?.textContent || '',
      startShortcut: start?.textContent?.includes('Ctrl+Alt+A') || false,
      editorPresent: Boolean(editor)
    };
  })()`;
  const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'renderer evaluation failed');
  const value = result.result?.value;
  if (!value?.syncView || !value.health || !value.group || !value.startShortcut || !value.editorPresent) throw new Error(JSON.stringify(value));
  process.stdout.write(JSON.stringify({ success: true, ...value }));
}

main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
