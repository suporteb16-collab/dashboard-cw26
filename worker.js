/**
 * Cloudflare Worker — dados do Classical Week 26 (CW26)
 * Maestro Thiago Santos · Agência B16
 *
 * Lê a planilha do lançamento pela Google Sheets API (service account) e devolve
 * UM JSON com as abas que o dashboard usa, já recortadas e sem dado pessoal.
 *
 * Por que as colunas são fixas aqui, e não um parâmetro `cols` como no worker
 * antigo: a planilha tem nome, e-mail, telefone, CPF e IP. Com o recorte vindo
 * do navegador, qualquer pessoa pediria `cols=A,B` e levaria os contatos. Aqui o
 * navegador não escolhe nada — quem decide o que sai é o servidor.
 *
 * E-mail e telefone saem só como HMAC-SHA256 truncado (`p_email`, `p_fone`).
 * Serve para contar gente distinta e cruzar lead × comprador, e não volta para o
 * e-mail sem a chave PII_SALT.
 *
 * SECRETS (Settings > Variables and Secrets, tipo "Secret"):
 *   SHEET_ID      → 1aseC7HcgcRqgCihXBtjng_0uUU2JyTjjcMs1mFwB6jw
 *   GOOGLE_SA_KEY → JSON completo da service account
 *   PII_SALT      → texto longo e aleatório (chave do HMAC). Trocar depois não quebra
 *                   o dashboard, só muda os códigos.
 *
 * A planilha precisa estar compartilhada como Leitor com o e-mail da service
 * account (campo `client_email` do JSON). Ela NÃO precisa — nem deve — ficar
 * pública: a aba leads tem contato de lead.
 *
 * USO:  GET /            → JSON de todas as abas (cache de 2 min no edge)
 *       GET /?fresh=1    → ignora o cache
 */

const CACHE_TTL = 120; // segundos


/* ------------------------------------------------------------------
   Recorte por aba. `col` é o nome do cabeçalho; `letra` é a posição.
   Tipos: txt · num · data · hash (sai como HMAC, nunca o valor) ·
          utm (lê uma URL e devolve só as utm_* como ref_source, ref_medium…;
               o resto da URL — fbclid, gclid — não sai).
   ------------------------------------------------------------------ */
const ABAS = {
  meta_ads: [
    { as: 'dia',           col: 'Date', tipo: 'data' },
    { as: 'campanha',      col: 'Campaign Name' },
    { as: 'conjunto',      col: 'Adset Name' },
    { as: 'anuncio',       col: 'Ad Name' },
    { as: 'gasto',         col: 'Spend (Cost, Amount Spent)', tipo: 'num' },
    { as: 'impressoes',    col: 'Impressions', tipo: 'num' },
    { as: 'cliques',       col: 'Action Link Clicks', tipo: 'num' },
    { as: 'checkouts',     col: 'Action FB Pixel Initiate Checkout (Offsite Conversion)', tipo: 'num' },
    { as: 'compras_pixel', col: 'Action FB Pixel Purchase (Offsite Conversion)', tipo: 'num' },
    { as: 'leads_pixel',   col: 'Action FB Pixel Lead (Offsite Conversion)', tipo: 'num' },
    { as: 'thumb',         col: 'Thumbnail URL' },
  ],

  /* A aba leads está com o CABEÇALHO DESALINHADO do dado nas colunas C–I: a
     coluna chamada "utm_source" guarda o e-mail, "utm_medium" guarda o
     utm_source, e assim por diante (conferido contra o Referrer em 26/10/2026).
     Por isso aqui a leitura é por letra. Se o fluxo que grava a aba for
     corrigido, `leadsAlinhado()` percebe e passa a ler pelo nome.
     As UTMs também saem do Referrer (URL da página no envio): os campos ocultos
     do formulário perdem atribuição — o conjunto "00 - Lista de compradores"
     tem gasto e 24 leads no Referrer e nenhum nos campos. O dashboard decide
     qual das duas usa. */
  leads: [
    { as: 'p_email',       letra: 'C', tipo: 'hash' },
    { as: 'p_fone',        letra: 'B', tipo: 'hash' },
    { as: 'origem',        letra: 'D' },   // utm_source: frio · quente · wpp1 · vazio
    { as: 'posicionamento',letra: 'E' },   // utm_term
    { as: 'criativo',      letra: 'F' },   // utm_content
    { as: 'campanha',      letra: 'G' },   // utm_campaign
    { as: 'conjunto',      letra: 'H' },   // utm_medium
    { as: 'formulario',    letra: 'J' },
    { as: 'criado_em',     letra: 'L', tipo: 'data' },
    { as: 'ref',           letra: 'P', tipo: 'utm' },   // Referrer: só as utm_* saem, nunca a URL
  ],
  leads_por_nome: [
    { as: 'p_email',       col: 'email', tipo: 'hash' },
    { as: 'p_fone',        col: 'Telefone*', tipo: 'hash' },
    { as: 'origem',        col: 'utm_source' },
    { as: 'posicionamento',col: 'utm_term' },
    { as: 'criativo',      col: 'utm_content' },
    { as: 'campanha',      col: 'utm_campaign' },
    { as: 'conjunto',      col: 'utm_medium' },
    { as: 'formulario',    col: 'Form Name (ID)' },
    { as: 'criado_em',     col: 'Created At', tipo: 'data' },
    { as: 'ref',           col: 'Referrer', tipo: 'utm' },
  ],

  /* vendas: log de webhook da Kiwify do Maestro inteiro, não só do CW26. O
     filtro do lançamento é do dashboard. Faturamento = coluna "Faturamento" da
     planilha (comissão do produtor, líquido) — contrato de receita da B16. */
  vendas: [
    { as: 'criado_em',     col: 'created_at', tipo: 'data' },
    { as: 'order_ref',     col: 'order_ref' },
    { as: 'status',        col: 'order_status' },
    { as: 'metodo',        col: 'payment_method' },
    { as: 'produto',       col: 'Product_product_name' },
    { as: 'plano',         col: 'Subscription_plan_name' },
    { as: 'p_email',       col: 'Customer_email', tipo: 'hash' },
    { as: 'p_fone',        col: 'Customer_mobile', tipo: 'hash' },
    { as: 'faturamento',   col: 'Faturamento', tipo: 'num' },
    { as: 'bruto_cent',    col: 'Commissions_charge_amount', tipo: 'num' },
    { as: 'utm_source',    col: 'TrackingParameters_utm_source' },
    { as: 'utm_medium',    col: 'TrackingParameters_utm_medium' },
    { as: 'utm_campaign',  col: 'TrackingParameters_utm_campaign' },
    { as: 'utm_content',   col: 'TrackingParameters_utm_content' },
    { as: 'utm_term',      col: 'TrackingParameters_utm_term' },
  ],

  planejamento: [
    { as: 'fase', col: 'Fase' },
    { as: 'tag',  col: 'TAG CAMPANHA' },
    { as: 'meta', col: 'Meta', tipo: 'num' },
  ],

  metas_vendas: [
    { as: 'vendas',      col: 'Vendas', tipo: 'num' },
    { as: 'faturamento', col: 'Faturamento', tipo: 'num' },
    { as: 'leads',       col: 'Leads Totais', tipo: 'num' },
    { as: 'conversao',   col: 'Conversão', tipo: 'num' },
    { as: 'inv_rmkt',    col: 'Investimento RMKT', tipo: 'num' },
    { as: 'roas',        col: 'ROAS', tipo: 'num' },
    { as: 'cac',         col: 'CAC', tipo: 'num' },
  ],
};
const ABAS_LIDAS = ['meta_ads', 'leads', 'vendas', 'planejamento', 'metas_vendas'];

/* ---------------------------- CORS ---------------------------- */
/* Liberado para qualquer origem: o que sai daqui já é público por desenho (sem dado
   pessoal), e quem quiser ler o JSON lê direto pela URL de qualquer jeito. Restringir
   a origem só criaria um jeito de o dashboard quebrar ao trocar de conta no GitHub. */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/* ------------------------ Google auth ------------------------- */
let tokenCache = { valor: null, expira: 0 };

const b64url = (bytes) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function accessToken(saRaw) {
  if (tokenCache.valor && Date.now() < tokenCache.expira) return tokenCache.valor;
  const sa = JSON.parse(saRaw);
  const agora = Math.floor(Date.now() / 1000);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const entrada = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: agora + 3600, iat: agora,
  })}`;
  const pem = sa.private_key.replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s/g, '');
  const chave = await crypto.subtle.importKey(
    'pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)).buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const assinatura = new Uint8Array(await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', chave, new TextEncoder().encode(entrada)));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${entrada}.${b64url(assinatura)}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Falha ao obter access_token: ' + JSON.stringify(d));
  tokenCache = { valor: d.access_token, expira: Date.now() + 50 * 60 * 1000 };
  return d.access_token;
}

/* ------------------------- conversões ------------------------- */
function letraParaIndice(l) {
  let n = 0;
  for (const ch of l.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const pad = n => String(n).padStart(2, '0');

/* Datas chegam como número de série (dateTimeRenderOption=SERIAL_NUMBER) quando a
   célula é data de verdade, e como texto quando é fórmula/colagem. Saem sempre como
   "AAAA-MM-DD HH:MM:SS" no horário da planilha — sem fuso, para o dashboard cortar
   o dia com `slice(0,10)` sem trocar a data. */
function paraData(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
         + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])} ${pad(m[4] || 0)}:${m[5] || '00'}:${m[6] || '00'}`;
  return null;
}

/* Número em formato BR ("1.234,56") ou US ("1,234.56") — o separador que vier por
   último é o decimal. */
function paraNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).replace(/[R$\s%]/g, '');
  const ultVirg = s.lastIndexOf(','), ultPonto = s.lastIndexOf('.');
  if (ultVirg > ultPonto) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function normalizaContato(v, ehFone) {
  if (v === null || v === undefined || v === '') return '';
  if (ehFone) {
    let d = String(typeof v === 'number' ? Math.round(v) : v).replace(/\D/g, '');
    if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
    return d.length >= 10 ? d : '';
  }
  const e = String(v).trim().toLowerCase();
  return e.includes('@') ? e : '';
}

const UTMS = ['source', 'medium', 'campaign', 'content', 'term'];
function utmsDaUrl(v, prefixo, o) {
  let q = null;
  try { q = new URL(String(v || '')).searchParams; } catch (e) { /* sem URL */ }
  for (const k of UTMS) {
    const val = q ? q.get('utm_' + k) : null;
    o[prefixo + '_' + k] = val && val.trim() ? val.trim() : null;
  }
}

async function hmac(chave, texto) {
  if (!texto) return null;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(texto)));
  return [...sig.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* --------------------------- Sheets --------------------------- */
async function lerAba(sheetId, aba, token) {
  const range = encodeURIComponent(`'${aba}'`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`
            + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Sheets ${r.status} na aba "${aba}": ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).values || [];
}

/* Cabeçalho certo = a coluna chamada "email" tem e-mail. No estado de 26/10 é a
   coluna "utm_source" que tem. */
function leadsAlinhado(linhas) {
  const cab = linhas[0] || [];
  const iEmail = cab.findIndex(h => String(h).trim().toLowerCase() === 'email');
  if (iEmail < 0) return false;
  const amostra = linhas.slice(1, 60).filter(l => l[iEmail] !== undefined && l[iEmail] !== '');
  const comArroba = amostra.filter(l => String(l[iEmail]).includes('@')).length;
  return amostra.length > 0 && comArroba / amostra.length > 0.5;
}

async function recortar(linhas, receita, chaveHmac) {
  if (!linhas.length) return [];
  const cab = linhas[0].map(h => String(h).trim());
  const idx = receita.map(c => c.letra ? letraParaIndice(c.letra) : cab.indexOf(c.col));
  const out = [];
  for (const l of linhas.slice(1)) {
    if (!l.some(v => v !== '' && v !== null && v !== undefined)) continue;
    const o = {};
    for (let k = 0; k < receita.length; k++) {
      const c = receita[k], i = idx[k];
      const v = i >= 0 ? l[i] : undefined;
      if (c.tipo === 'utm') utmsDaUrl(v, c.as, o);
      else if (c.tipo === 'hash') o[c.as] = await hmac(chaveHmac, normalizaContato(v, /fone/.test(c.as)));
      else if (c.tipo === 'num') o[c.as] = paraNum(v);
      else if (c.tipo === 'data') o[c.as] = paraData(v);
      else o[c.as] = (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
    }
    out.push(o);
  }
  return out;
}

async function montar(env) {
  const saRaw = typeof env.GOOGLE_SA_KEY === 'string' ? env.GOOGLE_SA_KEY : JSON.stringify(env.GOOGLE_SA_KEY);
  const token = await accessToken(saRaw);
  const chaveHmac = await crypto.subtle.importKey('raw',
    new TextEncoder().encode(env.PII_SALT || env.SHEET_ID),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

  const lidas = await Promise.allSettled(ABAS_LIDAS.map(a => lerAba(env.SHEET_ID, a, token)));
  const abas = {}, erros = {};
  for (let i = 0; i < ABAS_LIDAS.length; i++) {
    const nome = ABAS_LIDAS[i], res = lidas[i];
    if (res.status === 'rejected') { erros[nome] = res.reason.message; abas[nome] = []; continue; }
    let receita = ABAS[nome];
    if (nome === 'leads' && leadsAlinhado(res.value)) receita = ABAS.leads_por_nome;
    abas[nome] = await recortar(res.value, receita, chaveHmac);
  }
  return { gerado_em: new Date().toISOString(), abas, erros };
}

/* ---------------------------- entrada ---------------------------- */
export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders();
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Método não permitido', { status: 405, headers: cors });

    const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
      status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', ...extra } });

    if (!env.SHEET_ID || !env.GOOGLE_SA_KEY)
      return json({ error: 'Faltam os secrets SHEET_ID e/ou GOOGLE_SA_KEY no Worker.' }, 500);

    const url = new URL(request.url);
    const chaveCache = new Request(url.origin + '/__cw26', { method: 'GET' });
    const cache = caches.default;

    if (url.searchParams.get('fresh') !== '1') {
      const hit = await cache.match(chaveCache);
      if (hit) {
        const corpo = await hit.text();
        return new Response(corpo, { headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' } });
      }
    }

    try {
      const dados = await montar(env);
      const corpo = JSON.stringify(dados);
      ctx.waitUntil(cache.put(chaveCache, new Response(corpo, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}` } })));
      return new Response(corpo, { headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'MISS' } });
    } catch (err) {
      console.error('[CW26]', err.message);
      return json({ error: err.message }, 500);
    }
  },
};
