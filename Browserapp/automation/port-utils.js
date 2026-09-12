'use strict';

/**
 * Local port helpers.
 *
 * Starting a browser kernel needs a port nobody else holds. Asking the OS for
 * an ephemeral port and closing it immediately is the usual trick, but the
 * port is only free for the moment between close and reuse — so the caller
 * should treat the result as a preference, not a reservation.
 */

const net = require('net');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 1000;

/**
 * Test whether something is listening on host:port.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} true when a connection succeeds.
 */
function isPortOpen(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };

    const socket = net.createConnection({ host, port }, () => done(true));
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.on('error', () => done(false));
  });
}

/** Ask the OS for an unused port by binding to port 0, then releasing it. */
function findFreePort(host = DEFAULT_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close(() => {
        if (port === null) reject(new Error('could not determine a free port'));
        else resolve(port);
      });
    });
  });
}

/**
 * Return `preferred` when it is free, otherwise an OS-assigned free port.
 *
 * @param {number} [preferred]
 * @param {{host?:string, timeoutMs?:number}} [options]
 * @returns {Promise<number>}
 */
async function resolveAvailablePort(preferred, options = {}) {
  const host = options.host || DEFAULT_HOST;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;

  const candidate = Number(preferred);
  if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65535) {
    const taken = await isPortOpen(host, candidate, timeoutMs);
    if (!taken) return candidate;
  }
  return findFreePort(host);
}

/**
 * Find `count` distinct free ports.
 * Ports are collected in one pass so the result contains no duplicates.
 *
 * @param {number} count
 * @param {{host?:string}} [options]
 * @returns {Promise<number[]>}
 */
async function resolveAvailablePorts(count, options = {}) {
  const wanted = Math.max(0, Math.floor(Number(count) || 0));
  const found = new Set();
  // Bound the attempts: a hostile environment could keep handing back the same
  // port, and an unbounded loop would never return.
  const maxAttempts = wanted * 20 + 20;
  let attempts = 0;

  while (found.size < wanted && attempts < maxAttempts) {
    attempts += 1;
    const port = await findFreePort(options.host || DEFAULT_HOST);
    found.add(port);
  }
  return [...found];
}

module.exports = {
  isPortOpen,
  findFreePort,
  resolveAvailablePort,
  resolveAvailablePorts,
  DEFAULT_HOST,
  DEFAULT_TIMEOUT_MS,
};
