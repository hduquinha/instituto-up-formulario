# Dashboard Security Baseline

Este repositorio ainda nao contem o codigo do dashboard. Mesmo assim, a baseline de seguranca recomendada para um painel serverless na Vercel e esta:

## Acoes imediatas

1. Rotacionar qualquer credencial real que ja tenha aparecido em commit, README, print ou log.
2. Criar um usuario de banco somente leitura exclusivo para o dashboard.
3. Nao usar um unico `DASHBOARD_TOKEN` compartilhado como estrategia principal de autenticacao.

## Arquitetura recomendada

### 1. Protecao de borda na Vercel

- Ativar Deployment Protection.
- Se o dashboard precisar ficar privado tambem em producao, usar um plano/escopo que proteja All Deployments.
- Para time interno, a opcao mais simples e Vercel Authentication.

### 2. Autenticacao da aplicacao

- Usar uma biblioteca/provedor de auth: Auth.js, Clerk ou Better Auth.
- Preferir magic link, SSO ou credencial forte com MFA.
- Implementar RBAC com pelo menos `admin` e `viewer`.
- Fazer autorizacao no servidor e nao so no middleware.

### 3. Sessao

- Cookie de sessao com `HttpOnly`, `Secure`, `SameSite=Lax` ou `Strict`.
- Expiracao curta com renovacao controlada.
- Logout que invalida sessao no servidor.
- Se houver POST, PUT ou DELETE por cookie, aplicar protecao CSRF.

### 4. Banco de dados

- Nunca expor `DATABASE_URL` no cliente.
- Usar modulo server-only para acesso ao banco.
- Usuario readonly dedicado ao dashboard.
- Queries sempre parametrizadas.
- `orderBy` e filtros com allowlist, nunca interpolacao livre.
- Se possivel, expor uma `VIEW` com apenas os campos necessarios em vez do `payload` completo.

### 5. Segredos e ambientes

- Salvar segredos como Sensitive Environment Variables na Vercel.
- Separar credenciais de preview e producao.
- Rotacionar `AUTH_SECRET`, credenciais do banco e tokens periodicamente.
- Nao commitar `.env`, dumps, exports ou exemplos com segredos reais.

### 6. Firewall e abuso

- Aplicar WAF Rate Limiting em:
  - `/login`
  - `/api/inscricoes`
  - qualquer rota de exportacao
- Adicionar regras de challenge ou deny para comportamento suspeito.
- Se o painel for realmente interno, restringir por IP ou usar protecao de deployment adequada ao plano.

### 7. Headers e browser hardening

- Definir `Content-Security-Policy`.
- Definir `X-Frame-Options: DENY` ou equivalente via `frame-ancestors 'none'`.
- Definir `Referrer-Policy: strict-origin-when-cross-origin`.
- Definir `X-Content-Type-Options: nosniff`.
- Desabilitar `X-Powered-By`.

### 8. Observabilidade e auditoria

- Logar login, logout, falhas de auth e acesso a exportacoes.
- Nao logar segredos, cookies, tokens ou payload bruto desnecessariamente.
- Monitorar picos de erro, brute force e consultas fora do padrao.

## Minimo aceitavel

Se quiser uma baseline pragmatica e forte sem exagero:

1. Vercel Authentication ou protecao equivalente na borda.
2. Auth.js, Clerk ou Better Auth com sessao HttpOnly segura.
3. Usuario readonly no Postgres.
4. WAF rate limiting em login e APIs.
5. CSP mais headers defensivos.
6. Segredos apenas na Vercel, marcados como sensitive.

## Nao recomendado

- Dashboard publico com apenas um token fixo compartilhado.
- Mesmo usuario de banco para formulario e dashboard.
- Segredo em README, codigo ou historico git.
- Autorizacao apenas no frontend.
- API de listagem sem rate limit.
