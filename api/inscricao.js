const { Pool } = require('pg');

const SSL_QUERY_KEYS = [
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'sslpassword',
];

const SSL_DISABLE_VALUES = new Set(['0', 'false', 'disable', 'disabled', 'off', 'no']);
const SSL_STRICT_VALUES = new Set(['verify-ca', 'verify-full', 'strict']);

let pool;
let schemaReadyPromise;

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL nao configurada nas variaveis de ambiente.');
  }
  return databaseUrl;
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

function extractClientId(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.clientId) return String(payload.clientId).trim();
  if (payload._meta && payload._meta.clientId) {
    return String(payload._meta.clientId).trim();
  }
  return '';
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  try {
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
    res.status(500).json({ ok: false, error: err?.message || 'Erro ao salvar inscricao' });
  }
}

module.exports = handler;
module.exports.default = handler;
