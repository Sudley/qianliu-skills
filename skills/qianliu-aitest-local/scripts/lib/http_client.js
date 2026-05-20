'use strict';

const http = require('http');

/**
 * Lightweight HTTP client for the local AI test service.
 * Uses only Node.js built-in `http` module.
 */

function request(method, url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const timeout = options.timeout || 30000;

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: method,
      headers: {
        ...options.headers,
      },
    };

    if (options.body) {
      const bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      reqOptions.headers['Content-Type'] = 'application/json';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch (_) {
          // Keep as string if not JSON
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, data: parsed });
        } else {
          const err = new Error(`HTTP ${res.statusCode}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
          err.status = res.statusCode;
          err.response = parsed;
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Request failed: ${err.message}`));
    });

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`Request timeout after ${timeout}ms`));
    });

    if (options.body) {
      const bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      req.write(bodyStr);
    }

    req.end();
  });
}

function createLocalClient(port, clientId) {
  const baseUrl = `http://localhost:${port}`;
  const defaultHeaders = {
    'X-Client-ID': clientId,
  };

  return {
    get(path, options = {}) {
      return request('GET', `${baseUrl}${path}`, {
        ...options,
        headers: { ...defaultHeaders, ...options.headers },
      });
    },

    post(path, body = {}, options = {}) {
      return request('POST', `${baseUrl}${path}`, {
        ...options,
        body,
        headers: { ...defaultHeaders, ...options.headers },
      });
    },
  };
}

module.exports = { request, createLocalClient };
