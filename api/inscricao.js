const { Pool } = require('pg');

const SSL_QUERY_KEYS = [
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'sslpassword',
];

const MAX_BODY_BYTES = 64 * 1024;
const FALLBACK_TIMEOUT_MS = 8000;
const SSL_DISABLE_VALUES = new Set(['0', 'false', 'disable', 'disabled', 'off', 'no']);
const SSL_STRICT_VALUES = new Set(['verify-ca', 'verify-full', 'strict']);
const DATABASE_CONNECTIVITY_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);
const DEFAULT_ALLOWED_DEV_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
]);

let pool;
let schemaReadyPromise;

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL nao configurada nas variaveis de ambiente.');
  }
  return databaseUrl;
}

function getFallbackUrl() {
  const fallbackUrl = String(
    process.env.INSCRICAO_FALLBACK_URL ||
    process.env.FALLBACK_WEBHOOK_URL ||
    ''
  ).trim();

  if (!fallbackUrl) return '';

  try {
    const url = new URL(fallbackUrl);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return url.toString();
    }
  } catch {}

  console.error('INSCRICAO_FALLBACK_URL invalida.');
  return '';
}

function sanitizeConnectionString(connectionString) {
  try {
    const url = new URL(connectionString);

    for (const key of SSL_QUERY_KEYS) {
      url.searchParams.delete(key);
    }

    return url.toString();
  } catch {
    return connectionString;
  }
}

function getSslConfig() {
  const sslMode = String(process.env.PG_SSL || process.env.PGSSLMODE || '')
    .trim()
    .toLowerCase();

  if (SSL_DISABLE_VALUES.has(sslMode)) {
    return false;
  }

  return {
    rejectUnauthorized: SSL_STRICT_VALUES.has(sslMode),
  };
}

function appendVaryHeader(res, value) {
  const current = res.getHeader('Vary');
  const values = new Set(
    String(current || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );

  values.add(value);
  res.setHeader('Vary', Array.from(values).join(', '));
}

function getConfiguredAllowedOrigins() {
  return new Set(
    String(process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => normalizeOrigin(origin))
      .filter(Boolean)
  );
}

function normalizeOrigin(origin) {
  try {
    return new URL(origin).origin;
  } catch {
    return '';
  }
}

function getRequestHosts(req) {
  return [req.headers.host, req.headers['x-forwarded-host']]
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function getAllowedOrigin(req) {
  const origin = normalizeOrigin(req.headers.origin);
  if (!origin) return '';

  const configuredOrigins = getConfiguredAllowedOrigins();
  if (configuredOrigins.has(origin) || DEFAULT_ALLOWED_DEV_ORIGINS.has(origin)) {
    return origin;
  }

  const originHost = new URL(origin).host.toLowerCase();
  const requestHosts = new Set(getRequestHosts(req));

  return requestHosts.has(originHost) ? origin : '';
}

function setCommonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
}

function applyCors(req, res) {
  appendVaryHeader(res, 'Origin');
  appendVaryHeader(res, 'Access-Control-Request-Headers');

  const allowedOrigin = getAllowedOrigin(req);
  if (!allowedOrigin) {
    return false;
  }

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  return true;
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: sanitizeConnectionString(getDatabaseUrl()),
      ssl: getSslConfig(),
      max: 4,
      connectionTimeoutMillis: 8000,
    });

    pool.on('error', (err) => {
      console.error('Erro na conexao com Postgres:', err);
    });
  }

  return pool;
}

async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      const client = await getPool().connect();

      try {
        await client.query(`
          CREATE SCHEMA IF NOT EXISTS inscricoes;
          CREATE TABLE IF NOT EXISTS inscricoes.inscricoes (
            id SERIAL PRIMARY KEY,
            payload JSONB NOT NULL,
            criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
      } finally {
        client.release();
      }
    })().catch((err) => {
      schemaReadyPromise = undefined;
      throw err;
    });
  }

  return schemaReadyPromise;
}

function normalizePayload(body) {
  if (!body) return {};

  if (Buffer.isBuffer(body)) {
    return normalizePayload(body.toString('utf8'));
  }

  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return { raw: body };
    }
  }

  if (typeof body === 'object') {
    return body;
  }

  return { value: body };
}

function getPayloadSize(body) {
  if (!body) return 0;
  if (Buffer.isBuffer(body)) return body.length;
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');

  try {
    return Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function extractClientId(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.clientId) return String(payload.clientId).trim().slice(0, 128);
  if (payload._meta && payload._meta.clientId) {
    return String(payload._meta.clientId).trim().slice(0, 128);
  }
  return '';
}

function isDatabaseConfigurationError(err) {
  if (!err) return false;
  if (DATABASE_CONNECTIVITY_ERROR_CODES.has(err.code)) return true;
  return String(err.message || '').includes('DATABASE_URL');
}

function getPublicErrorMessage(err) {
  if (isDatabaseConfigurationError(err)) {
    return 'Banco de dados indisponivel. Verifique a DATABASE_URL na Vercel.';
  }

  return 'Nao foi possivel salvar a inscricao.';
}

function getPublicStatusCode(err) {
  return isDatabaseConfigurationError(err) ? 503 : 500;
}

function buildFallbackPayload(payload, clientId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  const meta = payload._meta && typeof payload._meta === 'object'
    ? { ...payload._meta }
    : {};

  if (clientId && !meta.clientId) meta.clientId = clientId;
  if (payload.page && !meta.page) meta.page = payload.page;
  if (payload._step && !meta.step) meta.step = payload._step;
  if (meta.final === undefined) meta.final = true;

  return { ...payload, _meta: meta };
}

async function tryFallbackSave(payload, clientId) {
  const fallbackUrl = getFallbackUrl();
  if (!fallbackUrl || typeof fetch !== 'function') return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FALLBACK_TIMEOUT_MS);

  try {
    const response = await fetch(fallbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildFallbackPayload(payload, clientId)),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');

    if (!response.ok) {
      console.error('Fallback de inscricao retornou status nao OK:', response.status, text.slice(0, 300));
      return false;
    }

    if (text) {
      try {
        const json = JSON.parse(text);
        if (json && json.ok === false) {
          console.error('Fallback de inscricao recusou o payload:', text.slice(0, 300));
          return false;
        }
      } catch {}
    }

    return true;
  } catch (err) {
    console.error('Falha ao acionar fallback de inscricao:', err);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function handler(req, res) {
  setCommonHeaders(res);

  const hasOriginHeader = typeof req.headers.origin === 'string' && req.headers.origin.length > 0;
  const corsAllowed = applyCors(req, res);

  if (hasOriginHeader && !corsAllowed) {
    res.status(403).json({ ok: false, error: 'Origem nao permitida.' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  try {
    if (getPayloadSize(req.body) > MAX_BODY_BYTES) {
      res.status(413).json({ ok: false, error: 'Payload muito grande.' });
      return;
    }

    await ensureSchema();

    const payload = normalizePayload(req.body);
    const clientId = extractClientId(payload);
    const pg = getPool();

    if (clientId) {
      const existing = await pg.query(
        "SELECT 1 FROM inscricoes.inscricoes WHERE payload->>'clientId' = $1 LIMIT 1",
        [clientId]
      );

      if (existing.rowCount) {
        res.status(200).json({ ok: true, deduped: true, clientId });
        return;
      }
    }

    await pg.query('INSERT INTO inscricoes.inscricoes (payload) VALUES ($1)', [payload]);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro ao processar inscricao:', err);

    const payload = normalizePayload(req.body);
    const clientId = extractClientId(payload);

    if (await tryFallbackSave(payload, clientId)) {
      res.status(200).json({ ok: true, fallback: true });
      return;
    }

    res.status(getPublicStatusCode(err)).json({ ok: false, error: getPublicErrorMessage(err) });
  }
}

module.exports = handler;
module.exports.default = handler;
