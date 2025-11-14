import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const PG_SSL = process.env.PG_SSL === 'true';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

if (!DATABASE_URL) {
  console.warn('DATABASE_URL não configurada nas variáveis de ambiente da Vercel.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PG_SSL ? { rejectUnauthorized: false } : undefined,
});

let schemaReadyPromise;

async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = pool.query(`
      CREATE SCHEMA IF NOT EXISTS inscricoes;
      CREATE TABLE IF NOT EXISTS inscricoes.inscricoes (
        id SERIAL PRIMARY KEY,
        payload JSONB NOT NULL,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).catch(err => {
      schemaReadyPromise = undefined;
      throw err;
    });
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
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
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
    await pool.query('INSERT INTO inscricoes.inscricoes (payload) VALUES ($1)', [payload]);

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

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro ao processar inscrição:', err);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({ ok: false, error: 'Erro ao salvar inscrição' });
  }
}
