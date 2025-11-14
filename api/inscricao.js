import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const PG_SSL = process.env.PG_SSL === 'true';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

let pool;
let schemaReadyPromise;

function getPool() {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL não configurada nas variáveis de ambiente.');
  }

  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: PG_SSL ? { rejectUnauthorized: false } : undefined,
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
    const pg = getPool();
    await pg.query('INSERT INTO inscricoes.inscricoes (payload) VALUES ($1)', [payload]);

    if (N8N_WEBHOOK_URL) {
      try {
        await fetch(N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (webhookErr) {
        console.error('Falha ao acionar o webhook do n8n:', webhookErr);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro ao processar inscrição:', err);
    res.status(500).json({ ok: false, error: err?.message || 'Erro ao salvar inscrição' });
  }
}
