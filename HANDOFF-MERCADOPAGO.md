# Integração Mercado Pago — Encontro Online · documento de passagem

> Status em 05/08/2026: **código pronto e testado, integração travada por
> configuração de credencial.** A produção NÃO foi afetada — continua no Asaas.

---

## 1. Objetivo

Trocar o link de pagamento externo (Asaas) por um **checkout próprio** no
formulário de inscrição do Encontro Online, usando a API do Mercado Pago.

Decisões de produto já fechadas com o cliente:

| Decisão | Valor |
|---|---|
| Meios de pagamento | Pix, cartão de crédito, cartão de débito, boleto |
| Parcelamento | **Só à vista (1x)** |
| Cupom de cortesia | Mantido como está: cupom aceito = 100% off, não passa pelo pagamento |
| Preço | R$ 297,00 |

---

## 2. O BLOQUEIO ATUAL (comece por aqui)

A cobrança não é criada. O endpoint devolve, hoje:

```json
{
  "ok": false,
  "error": "Nao foi possivel processar o pagamento agora.",
  "diagnostico": {
    "codigo": "mercadopago_recusou",
    "ambienteDoToken": "teste",
    "status": 401,
    "mpErro": null
  }
}
```

Leitura: a variável `MERCADOPAGO_ACCESS_TOKEN` **existe** e **começa com
`TEST-`** (ambiente certo), mas o Mercado Pago responde **401 — credencial
recusada**.

### Causa mais provável

**A public key foi colada no campo do access token.** As duas começam com
`TEST-`, o que faz o erro passar despercebido. Elas têm formatos diferentes:

| | Formato | Exemplo desta conta |
|---|---|---|
| **Public key** | `TEST-` + um UUID | `TEST-df758204-c68f-4381-a9d4-0a7d75e03769` |
| **Access token** | `TEST-<id da aplicação>-<data>-<hex>-<user id>` | deve **começar com `TEST-3757930189202305-`** e **terminar com `-463699143`** |

(Aplicação `3757930189202305`, User ID `463699143`, conforme o painel do MP.)

### Como confirmar em 5 segundos, sem expor o token

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer O_VALOR_QUE_ESTA_NA_VERCEL" \
  https://api.mercadopago.com/v1/payment_methods
```

`200` = access token válido · `401` = é a public key ou está errado.

---

## 3. Pontos de configuração que ficaram errados

Cinco coisas travaram o processo. Todas são de configuração, nenhuma é de código.

### 3.1 Access token inválido → **pendente**
Descrito acima. É o bloqueio principal.

### 3.2 Assinatura secreta do webhook nunca foi configurada → **pendente**
`MERCADOPAGO_WEBHOOK_SECRET` não existe no ambiente. Verificável de fora:

```bash
curl -s -X POST -d '{}' -H 'Content-Type: application/json' \
  https://<preview>/api/webhook-mercadopago
# hoje: {"ok":false,"motivo":"segredo_nao_configurado"}
# esperado depois de configurar: {"ok":false,"motivo":"assinatura_ausente"}
```

A assinatura secreta só é gerada **depois de salvar a URL** em
*Mercado Pago → Webhooks*.

### 3.3 Eventos errados marcados no webhook → **pendente**
Foram marcados **"Pagamentos (legacy)"** e **"Pedidos comerciais"**.

- ✅ *Pagamentos (legacy)* — serve, é o `payment`, o código trata.
- ❌ *Pedidos comerciais* — é o `merchant_order`, do mundo do Checkout Pro.
  O código responde 200 e ignora. Pode desmarcar.
- ⚠️ **Falta marcar "Order (Mercado Pago)"** — é o evento da API de Orders,
  que é justamente a API que esta integração usa. Sem ele, Pix e boleto não
  confirmam.

O handler aceita `payment`, `order` e `orders`; qualquer outro tipo devolve
200 e ignora.

### 3.4 "Webhook é só no plano Pro da Vercel" → **equívoco, já esclarecido**
Confusão com os **webhooks do próprio Vercel** (Team Settings → Webhooks, que
avisam o seu servidor sobre deploys) — esses sim são pagos. O que a integração
precisa é uma **rota de API** (`/api/webhook-mercadopago`), que é uma função
serverless igual à `/api/inscricao` que já roda em produção. Funciona no plano
gratuito.

### 3.5 Deployment Protection ligada no preview → **já resolvido**
O preview respondia `302 → vercel.com/sso-api` em tudo, inclusive no webhook —
o Mercado Pago receberia um redirecionamento para tela de login. Foi desligada
em *Settings → Deployment Protection → Vercel Authentication*.

### 3.6 Atenção ao escopo das variáveis na Vercel
Variáveis são **por ambiente**. Para o preview funcionar, elas precisam estar
marcadas em **Preview** (ou "All Environments"). Só em Production não vale.
E **toda variável nova exige um Redeploy** para as funções enxergarem.

---

## 4. Onde está o código

- Repositório: `github.com/hduquinha/instituto-up-formulario`
- Branch: **`pagamento-mercadopago`** — commits `de400d6`, `89d329a`, `18aae60`
- `main` continua no Asaas, **intocada**
- Deploy: **Vercel via git push** (push na branch = preview; push na main = produção)
- Preview atual:
  `https://instituto-up-formular-git-99207e-henriqueduquis1-9075s-projects.vercel.app`

### Arquivos novos

| Arquivo | Papel |
|---|---|
| `pagamento.html` | a tela do checkout, com o Payment Brick do MP |
| `api/pagamento.js` | `_action:'resumo'` devolve o valor; sem `_action`, cria a Order |
| `api/webhook-mercadopago.js` | recebe a confirmação do MP e grava no lead |
| `lib/mercadopago.js` | tudo que fala com o MP (Orders + assinatura) |
| `lib/db.js` | pool do Postgres usado pelas rotas novas |
| `tests/pagamento.test.js` | 34 checagens (`npm test`), sem banco e sem credencial |

### Arquivos modificados
`api/inscricao.js` (passa a devolver o `id` do INSERT e gerar `pagamento_token`),
`index.html`, `checkout-config.js`, `checkout.html`, `package.json`, `README.md`.

> ⚠️ **Há alterações não commitadas na branch** (`checkout-config.js`,
> `checkout.html`, `index.html`, `pagamento.html`): alguém adicionou um botão de
> WhatsApp com mensagem personalizada pelo nome e trocou o número de
> `5513997832766` para `551120901412`. **Não faz parte da integração do MP.**
> Commitar ou descartar antes de continuar.

---

## 5. Arquitetura

**Checkout Transparente com a API de Orders** — `POST https://api.mercadopago.com/v1/orders`.
Não é a antiga `/v1/payments`. A API de Orders é o padrão atual e trata cartão,
Pix e boleto pelo mesmo endpoint.

Front-end: **Payment Brick** (`https://sdk.mercadopago.com/js/v2`). É ele que
coleta e tokeniza o cartão dentro de um iframe do próprio MP — o número do
cartão nunca passa pelo nosso servidor.

### Fluxo

```
formulário (7 etapas) → api/inscricao.js grava o lead
                         e devolve { inscricaoId, pagamentoToken }
        ↓
pagamento.html?ref=<id>&t=<token>
   POST /api/pagamento {_action:'resumo'}      → nome + valor
   Payment Brick tokeniza o cartão
   POST /api/pagamento {ref,token,metodo,formData}
        ↓
api/pagamento.js  → POST /v1/orders no Mercado Pago
        ↓
api/webhook-mercadopago.js  ← MP avisa quando aprova (Pix/boleto)
        ↓
UPDATE no payload da inscrição
```

Cupom aceito **não** passa por aqui: vai direto para `checkout.html` (tela de
cortesia). `api/pagamento.js` devolve 409 se alguém com cortesia tentar pagar.

---

## 6. Regras de segurança — NÃO AFROUXAR

Estas quatro decisões são o que impede fraude. Qualquer alteração precisa
manter todas.

1. **O valor é decidido no servidor**, pela env `PRECO_ENCONTRO_ONLINE`
   (padrão `297.00`). O preço que o navegador enviar é ignorado. Sem isso,
   qualquer visitante abre o DevTools e paga R$ 1,00.
2. **`MERCADOPAGO_ACCESS_TOKEN` e `MERCADOPAGO_WEBHOOK_SECRET` só existem como
   variável de ambiente.** No `checkout-config.js`, que é público, vai apenas a
   *public key* — ela só tokeniza cartão, não move dinheiro.
3. **A cobrança exige o par `?ref=<id>&t=<token>`.** O `pagamento_token` é
   gerado no INSERT da inscrição e comparado em **tempo constante**
   (`crypto.timingSafeEqual`). Sem isso, trocar o número na URL abriria a
   cobrança de outra pessoa.
4. **O webhook trata a notificação como aviso, nunca como verdade.** Ele
   (a) valida o header `x-signature` — HMAC-SHA256 sobre o manifesto
   `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, com o `data.id`
   alfanumérico **em minúsculas** — e (b) depois **reconsulta o status na API
   do MP**. Sem as duas coisas, quem descobrir a URL declara qualquer inscrição
   como paga.

**Idempotência:** o header `X-Idempotency-Key` é obrigatório no POST. Para
cartão a chave usa o token do cartão (que é de uso único); para Pix e boleto
usa uma janela de 30 minutos, para que reenviar reaproveite a mesma cobrança e,
depois que o Pix expira, seja possível gerar outro.

---

## 7. Variáveis de ambiente (Vercel)

| Nome | Valor | Situação |
|---|---|---|
| `MERCADOPAGO_ACCESS_TOKEN` | access token da aplicação (**segredo**) | ⚠️ presente mas **inválido (401)** |
| `MERCADOPAGO_WEBHOOK_SECRET` | assinatura secreta do painel de webhooks (**segredo**) | ❌ não configurada |
| `PRECO_ENCONTRO_ONLINE` | `297.00` (opcional; padrão 297.00) | — |
| `DATABASE_URL` | Postgres das inscrições | ✅ funcionando no Preview |
| `CUPONS_ENCONTRO_ONLINE` | cupons de cortesia (já existia) | — |

Public key (não é segredo, fica em `checkout-config.js`):
`TEST-df758204-c68f-4381-a9d4-0a7d75e03769`

**A public key e o access token têm que ser do MESMO ambiente.** Misturar
`TEST-` com `APP_USR-` faz toda cobrança falhar com erro genérico.

---

## 8. O que já foi verificado

✅ `npm test` — 34 checagens passando, com Postgres e Mercado Pago simulados
(não precisa de credencial nem toca em dado real). Cobre: valor definido pelo
servidor, token inválido, cobrança dupla, cortesia, CORS, Pix pendente com QR,
assinatura de webhook forjada e "servidor sem segredo configurado".

✅ A página `pagamento.html` foi exercitada num Chromium real com o SDK do MP
simulado — 24 checagens: Brick montado com valor do servidor, 1 parcela, os
quatro meios habilitados, cartão aprovado, Pix com QR, cartão recusado sem
perder o preenchimento, cortesia desviada, e "sem public key" avisando em vez
de mostrar caixa quebrada.

✅ Handoff formulário → pagamento: 6 checagens (leva `ref` e token, cupom
recusado leva o motivo, cupom aceito vai para a cortesia, e sem `id` não navega
para cobrança quebrada).

✅ No preview: página abre (200), public key publicada, `DATABASE_URL`
funcionando (o `resumo` devolve 404 para inscrição inexistente), e as duas
rotas novas respondem com os erros próprios delas — não com o 302 do Vercel.

❌ **Nunca foi possível criar uma cobrança real**, por causa do 401.

---

## 9. O que fazer para destravar

1. **Corrigir o `MERCADOPAGO_ACCESS_TOKEN`** na Vercel (escopo Preview), com o
   valor de *Mercado Pago → Credenciais de teste → Access Token*. Validar com o
   `curl` da seção 2.
2. **Redeploy do preview** (variável nova só entra em build novo).
3. **Testar cartão** — não precisa do webhook, cartão responde na hora:
   - Já existe um lead de teste no banco: **`id 2188`**, com `pagamento_token`
     gravado. Dá para reaproveitar em vez de preencher o formulário de novo.
   - Cartão de teste: `5480 8328 0103 3311`, CVV `123`, validade `11/30`
   - **Nome do titular decide o resultado:** `APRO` aprova, `OTHE` recusa
   - CPF de teste: `12345678909`
   - E-mail: qualquer um, **menos** o da conta do Mercado Pago
   - Débito (Elo): `5067 7667 8388 8311`
4. **Configurar o webhook:** marcar **Order (Mercado Pago)** + *Pagamentos
   (legacy)*, salvar, copiar a assinatura secreta para
   `MERCADOPAGO_WEBHOOK_SECRET` (escopo Preview) e redeployar. Confirmar que o
   `motivo` virou `assinatura_ausente`.
5. **Testar Pix** — aí sim depende do webhook. Para pagar um Pix de teste é
   preciso uma conta de comprador em *TESTES → Contas de teste*.
6. **Produção:** merge da branch na `main`, trocar para as credenciais
   `APP_USR-...` (public key **e** access token juntos) e cadastrar o webhook
   de produção, que tem **assinatura secreta própria, diferente da de teste**.

---

## 10. O que a integração grava no lead

No `payload` JSONB de `inscricoes.inscricoes`:

| Campo | Valores |
|---|---|
| `pagamento_status` | `aprovado` \| `pendente` \| `recusado` |
| `pagamento_status_detalhe` | detalhe do MP |
| `pagamento_id`, `pagamento_order_id` | ids no Mercado Pago |
| `pagamento_metodo`, `pagamento_metodo_tipo` | ex.: `pix` / `bank_transfer` |
| `pagamento_valor` | valor cobrado |
| `pagamento_atualizado_em`, `pagamento_confirmado_em` | timestamps ISO |
| `pagamento_token` | segredo do link de cobrança (não exibir na ficha do lead) |
| `checkout_destino` | `mercado-pago` (antes de 04/08/2026 era `asaas`) |
| `email` | **só se o lead ainda não tiver** — o formulário nunca pediu e-mail, o Brick pede |

**Só `pagamento_status: aprovado` significa dinheiro recebido.**
`checkout_destino` quer dizer apenas "foi mandado para pagar".

CPF é coletado pelo Mercado Pago quando o meio exige, mas **não é gravado** no
nosso banco, de propósito.

---

## 11. Limitações conhecidas (não são bugs)

- **Reembolso e chargeback não têm tratamento.** O webhook marca
  `pagamento_status: recusado` quando o MP informa estorno, mas não devolve
  vaga nem avisa ninguém.
- **Boleto compensa em até 3 dias úteis.** Para turma com data próxima, pode
  aprovar depois do evento. Se virar problema, desligar `ticket` em
  `customization.paymentMethods` no `pagamento.html`.
- **O dashboard ainda não exibe `pagamento_status`.** Os campos aparecem soltos
  na ficha do lead. Fazer uma coluna "Pago / Pendente" é trabalho no outro
  repositório (`dashboard`), que é servido por Docker nesta VPS e exige rebuild.
- O QR do Pix **não é gravado** no banco de propósito (é imagem base64 que
  expira em 30 minutos e incharia o payload).

---

## 12. Regras do repositório que precisam ser respeitadas

Este projeto faz parte de um monorepo com regras próprias — ler antes de mexer:

- **`docs/cartilha-formularios-produtos.md`** é a fonte da verdade do mapeamento
  formulário → produto. A seção 7 documenta este checkout e a seção 8, as
  perguntas do formulário. Atualizar no mesmo commit de qualquer mudança.
- **`docs/deploy-map.md`** diz o que precisa de `git push` (Vercel) e o que
  precisa de rebuild Docker nesta VPS. Este formulário é **Grupo B**: push na
  `main` publica em produção.
- `FORM_IDENTITY_FIELDS` em `api/inscricao.js`: campos que definem de qual
  formulário o cadastro é. **Não podem ser herdados** quando um cadastro é
  reaproveitado por telefone. Os campos `cupom_*` e `checkout_destino` são
  reescritos em todo envio justamente por isso.
