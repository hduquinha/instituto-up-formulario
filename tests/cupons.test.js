// Testa o catalogo de cupons de api/inscricao.js com o Postgres SIMULADO.
//
// O que esta em jogo: desde 2026-08-10 os cupons vem da tabela
// `dashboard.coupons` (tela /cupons do CRM), com a variavel de ambiente
// CUPONS_ENCONTRO_ONLINE como reserva. Errar a precedencia entre as duas
// fontes tem consequencia de dinheiro nos dois sentidos — cupom desativado
// que continua dando entrada gratis, ou cortesia legitima recusada.
const path = require('path');
const Module = require('module');

const RAIZ = path.join(__dirname, '..');

process.env.ALLOWED_ORIGINS = 'https://exemplo.test';
process.env.CUPONS_ENCONTRO_ONLINE = 'SODAVARIAVEL,NOSDOIS:5,EXPIRADOENV::2020-01-01';
process.env.DATABASE_URL = 'postgresql://teste:teste@localhost:5432/teste';

// ---- Postgres falso -------------------------------------------------
// `cuponsNoBanco = null` simula a tabela ainda nao existir (primeiro deploy,
// antes de alguem abrir a tela) — a consulta estoura e o catalogo tem que
// cair inteiro para a variavel de ambiente.
let cuponsNoBanco = [];
let usosPorCodigo = {};

const poolFalso = {
  on(){ /* o handler registra um listener de erro no pool */ },
  // ensureSchema() pega um client e roda o CREATE TABLE de inscricoes; aqui
  // isso e um no-op, o que importa e nao explodir antes de chegar no cupom.
  async connect(){
    return { query: async () => ({ rows: [], rowCount: 0 }), release(){} };
  },
  async query(sql, params){
    const texto = String(sql).trim();

    if(/FROM dashboard\.coupons/.test(texto)){
      if(cuponsNoBanco === null){
        throw new Error('relation "dashboard.coupons" does not exist');
      }
      return { rows: cuponsNoBanco, rowCount: cuponsNoBanco.length };
    }

    if(/COUNT\(\*\)::int AS total/.test(texto)){
      return { rows: [{ total: usosPorCodigo[params[0]] || 0 }], rowCount: 1 };
    }

    throw new Error('SQL inesperado no teste: ' + texto);
  }
};

// api/inscricao.js monta o proprio Pool com `require('pg')` — o driver nem
// esta instalado aqui. Trocamos o modulo inteiro para que o handler use o
// Postgres falso sem saber.
const carregarModuloOriginal = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') {
    return { Pool: function FakePool(){ return poolFalso; } };
  }
  return carregarModuloOriginal.apply(this, arguments);
};

const inscricao = require(path.join(RAIZ, 'api/inscricao.js'));

// ---- Helpers de req/res ---------------------------------------------
function fakeRes(){
  return {
    _status: 0, _json: null, _headers: {},
    setHeader(k, v){ this._headers[k.toLowerCase()] = v; },
    getHeader(k){ return this._headers[k.toLowerCase()]; },
    status(c){ this._status = c; return this; },
    json(o){ this._json = o; return this; },
    end(){ return this; },
  };
}

async function validar(codigo){
  const res = fakeRes();
  await inscricao(
    { method: 'POST', headers: { host: 'exemplo.test' }, body: { _action: 'validarCupom', cupom: codigo }, query: {} },
    res
  );
  return (res._json && res._json.cupom) || {};
}

let falhas = 0;
function checar(nome, condicao, detalhe){
  if(condicao){ console.log('  ok   ', nome); }
  else { falhas++; console.log('  FALHA', nome, detalhe !== undefined ? '->' + JSON.stringify(detalhe) : ''); }
}

// =====================================================================
(async function rodar(){
  console.log('\n== cupons: tabela do CRM ==');
  cuponsNoBanco = [
    { code: 'DOBANCO', max_uses: null, valid_until: null, active: true },
    { code: 'COMLIMITE', max_uses: 2, valid_until: null, active: true },
    { code: 'VENCIDO', max_uses: null, valid_until: new Date('2020-01-01T00:00:00Z'), active: true },
  ];
  usosPorCodigo = {};

  let cupom = await validar('DOBANCO');
  checar('cupom cadastrado no CRM e aceito', cupom.aplicado === true, cupom);

  cupom = await validar('  dobanco  ');
  checar('minuscula e espaco nao impedem o cupom', cupom.aplicado === true, cupom);

  cupom = await validar('NAOEXISTE');
  checar('codigo desconhecido e recusado', cupom.aplicado === false && cupom.motivo === 'invalido', cupom);

  cupom = await validar('VENCIDO');
  checar('validade vencida e recusada', cupom.aplicado === false && cupom.motivo === 'expirado', cupom);

  usosPorCodigo = { COMLIMITE: 2 };
  cupom = await validar('COMLIMITE');
  checar('limite de usos atingido e recusado', cupom.aplicado === false && cupom.motivo === 'esgotado', cupom);

  usosPorCodigo = { COMLIMITE: 1 };
  cupom = await validar('COMLIMITE');
  checar('ainda com vaga, o cupom passa', cupom.aplicado === true, cupom);

  console.log('\n== cupons: precedencia sobre a variavel de ambiente ==');
  usosPorCodigo = {};
  cuponsNoBanco = [
    { code: 'NOSDOIS', max_uses: null, valid_until: null, active: false },
    { code: 'DOBANCO', max_uses: null, valid_until: null, active: true },
  ];

  cupom = await validar('SODAVARIAVEL');
  checar('codigo que so existe na variavel continua valendo', cupom.aplicado === true, cupom);

  cupom = await validar('NOSDOIS');
  checar(
    'desativar no CRM tira de circulacao mesmo com a variavel listando',
    cupom.aplicado === false && cupom.motivo === 'invalido',
    cupom
  );

  console.log('\n== cupons: banco indisponivel ==');
  cuponsNoBanco = null;

  cupom = await validar('SODAVARIAVEL');
  checar('tabela ausente cai para a variavel de ambiente', cupom.aplicado === true, cupom);

  cupom = await validar('EXPIRADOENV');
  checar('reserva mantem a validade de cada codigo', cupom.aplicado === false && cupom.motivo === 'expirado', cupom);

  cupom = await validar('DOBANCO');
  checar('sem banco, cupom que so existia na tabela nao passa', cupom.aplicado === false, cupom);

  console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
  process.exit(falhas === 0 ? 0 : 1);
})();
