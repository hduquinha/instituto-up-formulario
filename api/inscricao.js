// IMPORTANTE: Esta linha DEVE vir antes de qualquer import para funcionar na Vercel
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

let pool;
let schemaReadyPromise;

function getPool() {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL não configurada nas variáveis de ambiente.');
  }

  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: {
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined, // Ignora verificação de identidade do servidor
      },
      max: 4,
      connectionTimeoutMillis: 8000,
    });
    pool.on('error', (err) => {
      console.error('Erro na conexão com Postgres:', err);
    });
  }

  return pool;
}

async function ensureSchema() {
  if (!schemaReadyPromise) {
    const client = await getPool().connect();
    try {
      schemaReadyPromise = client.query(`
        CREATE SCHEMA IF NOT EXISTS inscricoes;
        CREATE TABLE IF NOT EXISTS inscricoes.inscricoes (
          id SERIAL PRIMARY KEY,
          payload JSONB NOT NULL,
          criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await schemaReadyPromise;
    } catch (err) {
      schemaReadyPromise = undefined;
      throw err;
    } finally {
      client.release();
    }
  }
  return schemaReadyPromise;
}

function normalizePayload(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return { raw: body };
    }
  }
  return body;
}

function extractClientId(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.clientId) return String(payload.clientId).trim();
  if (payload._meta && payload._meta.clientId) {
    return String(payload._meta.clientId).trim();
  }
  return '';
}

export default async function handler(req, res) {
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
        `SELECT 1 FROM inscricoes.inscricoes WHERE payload->>'clientId' = $1 LIMIT 1`,
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
    console.error('Erro ao processar inscrição:', err);
    res.status(500).json({ ok: false, error: err?.message || 'Erro ao salvar inscrição' });
  }
}
