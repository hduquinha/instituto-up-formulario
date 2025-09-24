# Servidor (Node.js) para salvar no Google Sheets — sem Apps Script

Este servidor Express escreve diretamente no Google Sheets via API usando uma Service Account. Use se você preferir não usar Google Apps Script.

## Passo a passo

1) Criar Service Account e credenciais
- Acesse Google Cloud Console > IAM & Admin > Service Accounts
- Crie uma Service Account (sem chave pública)
- Em "Keys" adicione uma nova chave do tipo JSON e baixe
- Do JSON, pegue os campos `client_email` e `private_key`

2) Compartilhar a planilha com a Service Account
- Abra sua planilha no Google Sheets
- Compartilhe com o email da Service Account (campo `client_email`) com permissão de Editor

3) Configurar variáveis ambiente
- Copie `.env.example` para `.env` e preencha:
  - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
  - `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (atenção às quebras de linha, use o formato com \n como no exemplo)
  - `SHEET_ID` (já preenchido com o seu ID)
  - `SHEET_NAME` (opcional, padrão `Leads`)
  - `PORT` (opcional)

4) Instalar e iniciar
- Na pasta `server`, instale dependências e inicie:
```
npm install
npm start
```

5) Testar
- GET http://localhost:5174/health → { ok: true }
- POST http://localhost:5174/save com body `text/plain` contendo JSON igual ao enviado pelo front (o `script.js` já envia).

## Usando no front-end
- Em `config.js`, você pode deixar `GAS_WEB_APP_URL` vazio e configurar o endpoint local no `script.js` (ou eu posso ajustar para você apontar para `http://localhost:5174/save`). Atualmente o front envia para o Apps Script se configurado. Posso alternar para detectar e usar o servidor local como prioridade.

## Observações
- Este servidor faz UPSERT por `clientId` (atualiza a mesma linha). Se preferir `append` entre em contato que eu ajusto rapidamente.
- Certifique-se que o email da Service Account tem acesso de edição na planilha, senão irá falhar com 403/404.
