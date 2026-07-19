const { LiveSyncController } = require('./live-sync-v4');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitIdle(controller, timeout = 5000) {
  const started = Date.now();
  while (controller.forwardQueueRunning || controller.forwardQueue.length) {
    if (Date.now() - started > timeout) throw new Error('forward queue did not become idle');
    await sleep(10);
  }
}

async function main() {
  const events = []; const observed = [];
  const controller = new LiveSyncController({ runningWithCdp: () => [] }, (event) => events.push(event));
  controller.master = { id: 'master' }; controller.slaves = [{ id: 'slave' }];
  controller.forward = async (_tabId, payload) => { await sleep(3); observed.push(payload); };

  for (let index = 0; index < 1000; index += 1) controller.enqueueForward('tab-1', { type: 'input', selector: '#q', value: String(index) });
  controller.enqueueForward('tab-1', { type: 'key', phase: 'down', key: 'Enter' });
  await waitIdle(controller);

  const inputs = observed.filter((payload) => payload.type === 'input');
  if (inputs.length > 3) throw new Error(`input coalescing failed: ${inputs.length}`);
  if (inputs.at(-1)?.value !== '999') throw new Error('latest input value was not preserved');
  if (observed.at(-1)?.type !== 'key') throw new Error('discrete key ordering was not preserved');
  if (controller.forwardStats.coalesced < 900) throw new Error('expected high-frequency events to be coalesced');
  if (!events.some((event) => event.type === 'sync-health')) throw new Error('sync health events were not emitted');

  process.stdout.write(JSON.stringify({ success: true, receivedInputs: inputs.length, coalesced: controller.forwardStats.coalesced, queueDepth: controller.forwardQueue.length, healthEvents: events.filter((event) => event.type === 'sync-health').length }));
}

main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
