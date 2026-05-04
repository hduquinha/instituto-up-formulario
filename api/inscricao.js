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
const PHONE_CONFLICT_DECISIONS = new Set([
  'reuse_existing',
  'edit_existing',
  'different_person',
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

function getSslModeFromDatabaseUrl() {
  try {
    return new URL(getDatabaseUrl()).searchParams.get('sslmode') || '';
  } catch {
    return '';
  }
}

function getSslConfig() {
  const sslMode = String(process.env.PG_SSL || process.env.PGSSLMODE || getSslModeFromDatabaseUrl())
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

function getPayloadAction(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return String(payload._action || '').trim().slice(0, 64);
}

function safeString(value, maxLength = 160) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizePhoneDigits(phone) {
  const digits = String(phone || '').replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.length > 11 && digits.startsWith('55')) return digits.slice(-11);
  if (digits.length > 11) return digits.slice(-11);
  return digits;
}

function normalizeDateKey(value) {
  const raw = safeString(value, 80);
  if (!raw) return '';

  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 10);
  }

  return raw.slice(0, 10);
}

function getEventNameFromPayload(payload) {
  return safeString(
    payload?.nome_evento ||
    payload?.evento ||
    payload?.treinamento ||
    payload?.training_name ||
    'Encontro UP',
    120
  ) || 'Encontro UP';
}

function getTrainingDateFromPayload(payload) {
  return safeString(
    payload?.data_treinamento ||
    payload?.data_evento ||
    payload?.training_date ||
    payload?.event_date,
    80
  );
}

function buildPhoneMatch(row, currentTrainingDate) {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  const trainingDate = getTrainingDateFromPayload(payload);

  return {
    id: row.id,
    registrationLabel: `cadastro #${row.id}`,
    nome: safeString(payload.nome || payload.name || 'Nome nao informado', 140),
    eventName: getEventNameFromPayload(payload),
    trainingDate,
    createdAt: row.criado_em instanceof Date ? row.criado_em.toISOString() : safeString(row.criado_em, 80),
    sameTraining: Boolean(
      normalizeDateKey(trainingDate) &&
      normalizeDateKey(trainingDate) === normalizeDateKey(currentTrainingDate)
    ),
  };
}

function getPhoneLookupQuery(extraWhere = '') {
  return `
    WITH base AS (
      SELECT
        id,
        payload,
        criado_em,
        regexp_replace(coalesce(payload->>'telefone', ''), '[^0-9]', '', 'g') AS digits
      FROM inscricoes.inscricoes
      WHERE coalesce(payload->>'telefone', '') <> ''
      ${extraWhere}
    ),
    normalized AS (
      SELECT
        id,
        payload,
        criado_em,
        CASE
          WHEN length(digits) > 11 AND left(digits, 2) = '55' THEN right(digits, 11)
          WHEN length(digits) > 11 THEN right(digits, 11)
          ELSE digits
        END AS phone_digits
      FROM base
    )
    SELECT id, payload, criado_em
    FROM normalized
    WHERE phone_digits = $1
    ORDER BY criado_em DESC
    LIMIT 1
  `;
}

async function findRegistrationByPhone(pg, phone) {
  const phoneDigits = normalizePhoneDigits(phone);
  if (phoneDigits.length < 10) return null;

  const result = await pg.query(getPhoneLookupQuery(), [phoneDigits]);
  return result.rows[0] || null;
}

async function findRegistrationByIdAndPhone(pg, id, phone) {
  const registrationId = Number.parseInt(id, 10);
  const phoneDigits = normalizePhoneDigits(phone);
  if (!registrationId || phoneDigits.length < 10) return null;

  const result = await pg.query(getPhoneLookupQuery('AND id = $2'), [phoneDigits, registrationId]);
  return result.rows[0] || null;
}

function shouldCopyIncomingValue(key, value) {
  if (key.startsWith('_')) return true;
  if ([
    'clientId',
    'timestamp',
    'data_preenchimento',
    'page',
    'data_treinamento',
    'traffic_source',
    'from_bio',
    'is_whatsapp_traffic',
    'is_bio_traffic',
    'audience_segment',
  ].includes(key)) {
    return true;
  }
  if (key.startsWith('utm_')) return true;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && !value.trim()) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function mergeExistingRegistrationPayload(existingPayload, incomingPayload) {
  const existing = existingPayload && typeof existingPayload === 'object' && !Array.isArray(existingPayload)
    ? existingPayload
    : {};
  const incoming = incomingPayload && typeof incomingPayload === 'object' && !Array.isArray(incomingPayload)
    ? incomingPayload
    : {};
  const merged = { ...existing };

  for (const [key, value] of Object.entries(incoming)) {
    if (shouldCopyIncomingValue(key, value)) {
      merged[key] = value;
    }
  }

  return merged;
}

function buildPhoneConflictMetadata(decision, matchRow) {
  const metadata = {
    decision,
    checkedAt: new Date().toISOString(),
    dashboardAlert: decision === 'different_person',
    verified: Boolean(matchRow),
  };

  if (matchRow) {
    const match = buildPhoneMatch(matchRow);
    metadata.existingRegistrationId = match.id;
    metadata.existingRegistrationLabel = match.registrationLabel;
    metadata.existingName = match.nome;
    metadata.existingEventName = match.eventName;
    metadata.existingTrainingDate = match.trainingDate;
    metadata.existingCreatedAt = match.createdAt;
  }

  return metadata;
}

async function preparePayloadForInsert(pg, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  const decision = safeString(payload._phoneConflictDecision, 40);
  if (!PHONE_CONFLICT_DECISIONS.has(decision)) {
    return payload;
  }

  const matchId = payload._existingRegistrationId || payload._phoneConflict?.existingRegistrationId;
  const matchRow = await findRegistrationByIdAndPhone(pg, matchId, payload.telefone);
  const prepared = decision === 'reuse_existing' && matchRow
    ? mergeExistingRegistrationPayload(matchRow.payload, payload)
    : { ...payload };

  prepared._phoneConflict = buildPhoneConflictMetadata(decision, matchRow);
  prepared._existingRegistrationId = matchRow ? matchRow.id : matchId || null;

  if (decision === 'reuse_existing') {
    prepared.reaproveitou_cadastro_existente = true;
    prepared.cadastro_reaproveitado_id = matchRow ? matchRow.id : matchId || null;
  }

  if (decision === 'edit_existing') {
    prepared.atualizacao_de_cadastro_existente = true;
    prepared.cadastro_atualizado_id = matchRow ? matchRow.id : matchId || null;
  }

  if (decision === 'different_person') {
    prepared.telefone_duplicado_confirmado = true;
    prepared.telefone_duplicado_alerta_dashboard = true;
    prepared.alerta_dashboard = 'telefone_duplicado';
    prepared.telefone_duplicado_com_cadastro_id = matchRow ? matchRow.id : matchId || null;
  }

  return prepared;
}

async function handlePhoneLookup(pg, payload, res) {
  const phoneDigits = normalizePhoneDigits(payload.telefone || payload.phone);
  if (phoneDigits.length < 10) {
    res.status(422).json({ ok: false, error: 'Telefone invalido.' });
    return;
  }

  const matchRow = await findRegistrationByPhone(pg, phoneDigits);
  if (!matchRow) {
    res.status(200).json({ ok: true, found: false });
    return;
  }

  res.status(200).json({
    ok: true,
    found: true,
    match: buildPhoneMatch(matchRow, payload.data_treinamento),
  });
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
    const action = getPayloadAction(payload);
    const clientId = extractClientId(payload);
    const pg = getPool();

    if (action === 'lookupPhone') {
      await handlePhoneLookup(pg, payload, res);
      return;
    }

    if (action) {
      res.status(400).json({ ok: false, error: 'Acao invalida.' });
      return;
    }

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

    const payloadToInsert = await preparePayloadForInsert(pg, payload);

    await pg.query('INSERT INTO inscricoes.inscricoes (payload) VALUES ($1)', [payloadToInsert]);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro ao processar inscricao:', err);

    const payload = normalizePayload(req.body);
    const clientId = extractClientId(payload);
    const action = getPayloadAction(payload);

    if (action) {
      res.status(getPublicStatusCode(err)).json({ ok: false, error: getPublicErrorMessage(err) });
      return;
    }

    if (await tryFallbackSave(payload, clientId)) {
      res.status(200).json({ ok: true, fallback: true });
      return;
    }

    res.status(getPublicStatusCode(err)).json({ ok: false, error: getPublicErrorMessage(err) });
  }
}

module.exports = handler;
module.exports.default = handler;
