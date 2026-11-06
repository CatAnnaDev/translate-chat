'use strict';

const https = require('https');
const { URL } = require('url');

const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 8, maxFreeSockets: 4, scheduling: 'lifo', timeout: 10000 });

function request(url, { method = 'GET', headers = {}, body = null, timeout = 2000, maxBytes = 262144 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }

    const payload = body === null || body === undefined ? null : Buffer.from(body);
    const req = https.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      agent,
      headers: Object.assign({ Accept: '*/*', 'Accept-Encoding': 'identity' }, headers, payload ? { 'Content-Length': payload.length } : {}),
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(new Error('response too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', e => done(reject, e));
    });

    timer = setTimeout(() => {
      const e = new Error(`timeout after ${timeout} ms`);
      e.code = 'ETIMEDOUT';
      done(reject, e);
      req.destroy();
    }, timeout);

    req.on('error', e => done(reject, e));
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { request };
