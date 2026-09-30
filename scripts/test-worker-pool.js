/**
 * Quick smoke-test for the WhisperWorkerService pool.
 *
 * Run with:  node scripts/test-worker-pool.js  (from OpenCluely root)
 */

'use strict';

let workerCount = 0;

class MockWorkerProcess {
  constructor({ id }) {
    this.id = id;
    this.busy = false;
    this.process = { killed: false };
  }

  request(payload) {
    if (this.busy) throw new Error(`Worker ${this.id} already busy!`);
    this.busy = true;
    const delay = payload._testDelayMs || 100;
    return new Promise((resolve) => {
      setTimeout(() => {
        this.busy = false;
        resolve({ ok: true, text: `result-${payload.id}`, workerId: this.id });
      }, delay);
    });
  }

  close() { this.process = null; }
}

// Patch _runOrQueue to inject mocks instead of real Python processes
const WhisperWorkerService = require('../src/services/whisper-worker.service.js');

WhisperWorkerService.prototype._runOrQueue = function (job) {
  let worker = this._workers.find((w) => !w.busy);

  if (!worker && this._workers.length < this.maxWorkers) {
    workerCount++;
    worker = new MockWorkerProcess({ id: workerCount });
    this._workers.push(worker);
    console.log(`  [pool] spawned mock worker #${this._workers.length}`);
  }

  if (worker) {
    this._runJob(worker, job);
  } else {
    this._jobQueue.push(job);
    console.log(`  [pool] queued (depth: ${this._jobQueue.length})`);
  }
};

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    console.log('PASS');
  } catch (err) {
    console.log(`FAIL: ${err.message}`);
    process.exitCode = 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makePool() {
  const pool = new WhisperWorkerService(2);
  pool.configure({ pythonPath: '/fake', scriptPath: '/fake' });
  pool.isConfigured = () => true;
  pool._clearIdleTimer = () => {};
  pool._scheduleIdleUnload = () => {};
  return pool;
}

async function main() {
  console.log('\n=== WhisperWorkerService pool smoke tests ===\n');

  await test('Single request dispatches to worker', async () => {
    const pool = makePool();
    const r = await pool._dispatch({ id: 1, _testDelayMs: 50 });
    if (pool._workers.length !== 1) throw new Error('Expected 1 worker');
    if (r.text !== 'result-1') throw new Error(`Unexpected: ${r.text}`);
  });

  workerCount = 0;
  await test('Two concurrent requests spawn 2 workers', async () => {
    const pool = makePool();
    const [r1, r2] = await Promise.all([
      pool._dispatch({ id: 1, _testDelayMs: 80 }),
      pool._dispatch({ id: 2, _testDelayMs: 80 })
    ]);
    if (pool._workers.length !== 2) throw new Error(`Expected 2 workers, got ${pool._workers.length}`);
    if (!r1.ok || !r2.ok) throw new Error('Both should be ok');
  });

  workerCount = 0;
  await test('Third request queues when pool full (2 workers)', async () => {
    const pool = makePool();
    const p1 = pool._dispatch({ id: 1, _testDelayMs: 100 });
    const p2 = pool._dispatch({ id: 2, _testDelayMs: 100 });
    const p3 = pool._dispatch({ id: 3, _testDelayMs: 50 });
    await sleep(10);
    if (pool._jobQueue.length !== 1) throw new Error(`Expected 1 queued, got ${pool._jobQueue.length}`);
    await Promise.all([p1, p2, p3]);
    if (pool._jobQueue.length !== 0) throw new Error('Queue should be empty');
  });

  workerCount = 0;
  await test('Faster worker result arrives independently (parallel confirmed)', async () => {
    const pool = makePool();
    const order = [];
    const p1 = pool._dispatch({ id: 1, _testDelayMs: 120 }).then((r) => { order.push(r.workerId); return r; });
    const p2 = pool._dispatch({ id: 2, _testDelayMs: 30 }).then((r) => { order.push(r.workerId); return r; });
    await Promise.all([p1, p2]);
    if (order[0] === order[1]) throw new Error('Expected different workers');
    console.log(`    (finish order: worker ${order[0]} → worker ${order[1]}, 2nd was faster — parallel OK)`);
  });

  console.log('\n=== All done ===\n');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exitCode = 1;
});
