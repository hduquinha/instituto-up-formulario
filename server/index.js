import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { randomUUID } from 'crypto';

dotenv.config();

const PORT = process.env.PORT || 5174;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Leads';

if(!SHEET_ID){
  console.error('SHEET_ID não definido. Configure no .env');
}

const app = express();
app.use(cors());
app.use(express.text({ type: [ 'text/plain', 'application/json' ] }));

app.get('/health', (req,res)=>{
  res.json({ ok: true });
});

app.post('/save', async (req,res)=>{
  try{
    const body = JSON.parse(req.body || '{}');
    const meta = body._meta || {};
  const clientId = String(meta.clientId || '').trim() || randomUUID();
    const ts = new Date();

    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // Garantir cabeçalhos
    const headers = [
      'timestamp','clientId','step','final','nome','telefone','email','instagram',
      'renda','ocupacao','area','satisfacao_trabalho','ansiedade','estresse','impacto_emocional','page'
    ];

    await ensureHeader(sheets, headers);

    // Buscar todos os clientIds para upsert
    const idColRange = `${SHEET_NAME}!B2:B`;
    const idResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: idColRange });
    const ids = (idResp.data.values || []).map(r => r[0]);
    const rowIndex = ids.findIndex(x => String(x) === clientId);

    const rowObj = {
      timestamp: ts.toISOString().replace('T',' ').slice(0,19),
      clientId,
      step: meta.step || '',
      final: !!meta.final,
      nome: body.nome || '',
      telefone: body.telefone || '',
      email: body.email || '',
      instagram: body.instagram || '',
      renda: body.renda || '',
      ocupacao: body.ocupacao || '',
      area: body.area || '',
      satisfacao_trabalho: body.satisfacao_trabalho || '',
      ansiedade: body.ansiedade || '',
      estresse: body.estresse || '',
      impacto_emocional: body.impacto_emocional || '',
      page: meta.page || ''
    };

    const row = headers.map(h => rowObj[h] ?? '');

    if(rowIndex >= 0){
      // Update existing row
      const targetRow = rowIndex + 2; // offset header + 1-based
      const range = `${SHEET_NAME}!A${targetRow}:P${targetRow}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range,
        valueInputOption: 'RAW',
        requestBody: { values: [ row ] }
      });
    } else {
      // Append new row
      const range = `${SHEET_NAME}!A:P`;
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [ row ] }
      });
    }

    res.json({ ok: true, clientId });
  }catch(err){
    console.error(err);
    res.status(500).json({ ok:false, error: String(err?.message || err) });
  }
});

app.listen(PORT, '127.0.0.1', ()=>{
  console.log(`Servidor iniciado em http://localhost:${PORT}`);
});

async function getAuth(){
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\n/g, '\n');
  if(!clientEmail || !privateKey){
    throw new Error('Credenciais do serviço não configuradas (GOOGLE_SERVICE_ACCOUNT_EMAIL/PRIVATE_KEY)');
  }
  const jwt = new google.auth.JWT({ email: clientEmail, key: privateKey, scopes });
  await jwt.authorize();
  return jwt;
}

async function ensureHeader(sheets, headers){
  const range = `${SHEET_NAME}!A1:P1`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  const current = (resp.data.values && resp.data.values[0]) || [];
  if(JSON.stringify(current) !== JSON.stringify(headers)){
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [ headers ] }
    });
  }
}
