// =====================================================================
// Conexão com o Postgres das inscrições
// ---------------------------------------------------------------------
// Usado pelas rotas novas de pagamento (api/pagamento.js e
// api/webhook-mercadopago.js).
//
// `api/inscricao.js` NÃO usa este módulo: ele tem a própria cópia dessa
// configuração desde antes. A duplicação é proposital — trocar a conexão
// do caminho que grava TODAS as inscrições no mesmo commit em que se
// constrói o pagamento seria arriscar o que já funciona por uma questão
// de estilo. Quando o pagamento estiver rodando em produção e testado,
// aí sim vale unificar os dois.
// =====================================================================
const { Pool } = require('pg');

const SSL_QUERY_KEYS = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword'];
const SSL_DISABLE_VALUES = new Set(['0', 'false', 'disable', 'disabled', 'off', 'no']);
const SSL_STRICT_VALUES = new Set(['verify-ca', 'verify-full', 'strict']);

let pool;

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL nao configurada nas variaveis de ambiente.');
  }
  return databaseUrl;
}

// O `pg` recusa alguns parâmetros de SSL vindos na querystring; a conexão
// é limpa aqui e o modo volta pelo objeto `ssl` logo abaixo.
function sanitizeConnectionString(connectionString) {
  try {
    const url = new URL(connectionString);
    for (const key of SSL_QUERY_KEYS) url.searchParams.delete(key);
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

  if (SSL_DISABLE_VALUES.has(sslMode)) return false;
  return { rejectUnauthorized: SSL_STRICT_VALUES.has(sslMode) };
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

module.exports = { getPool };
