'use strict';
const net = require('node:net');
const { once } = require('node:events');

class Reader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.error = null;
    this.data = chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.pump(); };
    this.failure = error => { this.error = error instanceof Error ? error : new Error('Socket ended'); this.pump(); };
    socket.on('data', this.data);
    socket.on('error', this.failure);
    socket.on('end', this.failure);
  }
  pump() {
    while (this.waiters.length) {
      const waiter = this.waiters[0];
      const size = typeof waiter.size === 'number' ? waiter.size : (() => {
        const index = this.buffer.indexOf(waiter.size);
        return index < 0 ? -1 : index + waiter.size.length;
      })();
      if (size >= 0 && this.buffer.length >= size) {
        this.waiters.shift(); clearTimeout(waiter.timer);
        const data = this.buffer.subarray(0, size);
        this.buffer = this.buffer.subarray(size); waiter.resolve(data);
      } else if (this.error) {
        this.waiters.shift(); clearTimeout(waiter.timer); waiter.reject(this.error);
      } else break;
    }
  }
  read(size, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const waiter = { size, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(value => value !== waiter);
        reject(new Error('Fixture read deadline')); this.socket.destroy();
      }, timeout);
      this.waiters.push(waiter); this.pump();
    });
  }
  release() {
    if (this.waiters.length) throw new Error('Reader still has pending requests');
    this.socket.pause();
    this.socket.off('data', this.data); this.socket.off('error', this.failure); this.socket.off('end', this.failure);
    return this.buffer;
  }
}

async function connect(port, host = '127.0.0.1') {
  const socket = net.connect(port, host);
  socket.on('error', () => {});
  await once(socket, 'connect');
  return socket;
}

async function listen(handler) {
  const sockets = new Set();
  const errors = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    Promise.resolve().then(() => handler(socket)).catch(error => { errors.push(error); socket.destroy(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, sockets, errors,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

async function socksServer({ username, password } = {}) {
  const targets = [];
  const peers = new Set();
  const server = await listen(async socket => {
    const input = new Reader(socket);
    const greeting = await input.read(2);
    if (greeting[0] !== 5) throw new Error('Bad SOCKS version');
    const methods = await input.read(greeting[1]);
    const method = username === undefined ? 0 : 2;
    if (!methods.includes(method)) { socket.end(Buffer.from([5, 255])); return; }
    socket.write(Buffer.from([5, method]));
    if (method === 2) {
      const head = await input.read(2);
      const user = (await input.read(head[1])).toString();
      const length = (await input.read(1))[0];
      const pass = (await input.read(length)).toString();
      if (head[0] !== 1 || user !== username || pass !== password) { socket.end(Buffer.from([1, 1])); return; }
      socket.write(Buffer.from([1, 0]));
    }
    const head = await input.read(4);
    if (head[0] !== 5 || head[1] !== 1 || head[2] !== 0) throw new Error('Bad SOCKS CONNECT');
    let host;
    if (head[3] === 1) host = [...await input.read(4)].join('.');
    else if (head[3] === 3) host = (await input.read((await input.read(1))[0])).toString();
    else throw new Error('Fixture accepts IPv4 or loopback domain');
    const port = (await input.read(2)).readUInt16BE();
    targets.push({ host, port });
    if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('Fixture only dials loopback');
    const peer = await connect(port, host);
    peers.add(peer); peer.on('close', () => peers.delete(peer));
    const remainder = input.release();
    socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]));
    if (remainder.length) peer.write(remainder);
    socket.pipe(peer); peer.pipe(socket); socket.resume();
    socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
  });
  const close = server.close;
  server.close = async () => { for (const peer of peers) peer.destroy(); await close(); };
  return Object.assign(server, { targets });
}

module.exports = { Reader, connect, listen, socksServer };
