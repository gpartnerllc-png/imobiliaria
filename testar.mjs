import { pathToFileURL } from 'node:url';
import path from 'node:path';

const mod = await import(pathToFileURL(path.resolve('worker/src/index.js')).href);
const worker = mod.default;

// ---- Mock D1 em memória (SQLite-like mínimo) ----
const tabelas = {};
let autoId = 0;
const nextId = () => ++autoId;

function valorToken(t, params, pi) {
  if (t === '?') { pi.i++; return params[pi.i - 1] ?? null; }
  if (/^'.*'$/.test(t)) return t.slice(1, -1);
  if (t === 'NULL') return null;
  if (/^datetime\(/.test(t)) return new Date().toISOString();
  const n = Number(t);
  return Number.isNaN(n) ? t : n;
}

class Stmt {
  constructor(sql) { this.sql = sql; this.params = []; }
  bind(...p) { this.params = p; return this; }

  async first() {
    const sql = this.sql;

    const ret = sql.match(/INSERT INTO (\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*RETURNING id/i);
    if (ret) {
      const nome = ret[1];
      const cols = ret[2].split(',').map(s => s.trim());
      tabelas[nome] = tabelas[nome] || [];
      const toks = ret[3].split(',');
      const row = { id: nextId() };
      const pi = { i: 0 };
      cols.forEach((c, i) => { row[c] = valorToken((toks[i] || '').trim(), this.params, pi); });
      if (nome === 'listings' && row.status === undefined) row.status = 'ativo';
      if (['listings', 'leads', 'pagamentos'].includes(nome) && row.created_at === undefined) row.created_at = new Date().toISOString();
      tabelas[nome].push(row);
      return row;
    }

    if (/COUNT\(\*\) AS n/.test(sql)) {
      const nome = (sql.match(/FROM (\w+)/i) || [])[1];
      let rows = tabelas[nome] || [];
      const where = sql.match(/WHERE ([^;]*?)(?: ORDER| LIMIT|$)/i);
      if (where) {
        const iguals = [...where[1].matchAll(/([a-z_.]+)\s*=\s*\?/gi)];
        rows = rows.filter(r => iguals.every((g, gi) => String(r[g[1].split('.').pop()]) === String(this.params[gi])));
      }
      return { n: rows.length };
    }

    const m = sql.match(/SELECT \* FROM (\w+)/i) || sql.match(/SELECT [\s\S]*? FROM (\w+)/i);
    if (!m) return null;
    const nome = m[1];
    let rows = (tabelas[nome] || []).map(r => ({ ...r }));
    if (/JOIN tenants/i.test(sql)) {
      rows = rows.map(r => {
        const t = (tabelas.tenants || []).find(x => String(x.id) === String(r.tenant_id));
        return { ...r, nome_exibicao: t?.nome_exibicao, subdominio: t?.subdominio, plano: t?.plano, status_licenca: t?.status_licenca, limite_anuncios: t?.limite_anuncios, tipo_perfil: t?.tipo_perfil, nome: t?.nome, whatsapp: t?.whatsapp, creci: t?.creci, logo_url: t?.logo_url, sobre: t?.sobre };
      });
    }
    const where = sql.match(/WHERE ([^;]*?)(?: ORDER| LIMIT|$)/i);
    if (where) {
      const cond = where[1];
      const iguals = [...cond.matchAll(/([a-z_.]+)\s*=\s*\?/gi)];
      rows = rows.filter(r => iguals.every((g, gi) => String(r[g[1].split('.').pop()]) === String(this.params[gi])));
      const lits = [...cond.matchAll(/([a-z_.]+)\s*(=|!=)\s*'([^']*)'/gi)];
      rows = rows.filter(r => lits.every(g => {
        const v = r[g[1].split('.').pop()];
        return g[2] === '=' ? String(v) === g[3] : String(v) !== g[3];
      }));
    }
    return rows[0] || null;
  }

  async run() {
    const sql = this.sql;

    const ins = sql.match(/INSERT (?:OR IGNORE )?INTO (\w+)\s*\(([^)]*)\)\s*VALUES\s*([\s\S]+)/i);
    if (ins) {
      const nome = ins[1];
      const cols = ins[2].split(',').map(s => s.trim());
      tabelas[nome] = tabelas[nome] || [];
      const grupos = [...ins[3].matchAll(/\(([^)]*)\)/g)];
      let changes = 0;
      for (const g of grupos) {
        const toks = g[1].split(',');
        if (/OR IGNORE/i.test(sql)) {
          const chave = (toks[0] || '').trim().replace(/^'|'$/g, '');
          if (tabelas[nome].some(r => String(r[cols[0]]) === chave)) continue;
        }
        const row = { id: nextId() };
        const pi = { i: 0 };
        cols.forEach((c, i) => { row[c] = valorToken((toks[i] || '').trim(), this.params, pi); });
        if (nome === 'listings' && row.status === undefined) row.status = 'ativo';
        if (['listings', 'leads', 'pagamentos'].includes(nome) && row.created_at === undefined) row.created_at = new Date().toISOString();
        tabelas[nome].push(row);
        changes++;
      }
      return { meta: { changes } };
    }

    const upd = sql.match(/UPDATE (\w+) SET ([\s\S]*?) WHERE ([\s\S]*)/i);
    if (upd) {
      const nome = upd[1];
      const pi = { i: 0 };
      const ops = [];
      const assig = [...upd[2].matchAll(/([a-z_]+)\s*=\s*([^,]+?)(?=,\s*[a-z_]+\s*=|$)/gi)];
      for (const a of assig) {
        const col = a[1];
        const val = a[2].trim();
        if (val === '?') ops.push({ col, val: this.params[pi.i++] ?? null });
        else if (/^'.*'$/.test(val)) ops.push({ col, val: val.slice(1, -1) });
        else if (val === 'NULL') ops.push({ col, val: null });
        else if (/^datetime\(/.test(val)) ops.push({ col, val: new Date().toISOString() });
        else if (/^[a-z_]+\s*[+-]\s*\d+$/i.test(val)) ops.push({ col, delta: val });
        else if (/^(?:MAX\(\d+,\s*)?[a-z_]+/.test(val)) ops.push({ col, delta: val });
        else ops.push({ col, val: null });
      }
      const w = upd[3];
      const wIguals = [...w.matchAll(/([a-z_.]+)\s*=\s*\?/gi)];
      const wLits = [...w.matchAll(/([a-z_.]+)\s*=\s*'([^']*)'/gi)];
      let n = 0;
      for (const r of (tabelas[nome] || [])) {
        const bate = wIguals.every((g, gi) => String(r[g[1].split('.').pop()]) === String(this.params[pi.i + gi])) &&
                     wLits.every(g => String(r[g[1].split('.').pop()]) === g[2]);
        if (!bate) continue;
        for (const op of ops) {
          if (op.delta) {
            const dm = op.delta.match(/([a-z_]+)\s*([+-])\s*(\d+)/i);
            if (dm) r[op.col] = (Number(r[dm[1]]) || 0) + (dm[2] === '+' ? 1 : -1) * Number(dm[3]);
          } else {
            r[op.col] = op.val;
          }
        }
        n++;
      }
      return { meta: { changes: n } };
    }

    const del = sql.match(/DELETE FROM (\w+)/i);
    if (del) {
      const nome = del[1];
      const antes = (tabelas[nome] || []).length;
      tabelas[nome] = [];
      return { meta: { changes: antes } };
    }
    return { meta: { changes: 1 } };
  }

  async all() {
    const sql = this.sql;
    const m = sql.match(/FROM (\w+)/i);
    const nome = m ? m[1] : null;
    let rows = (tabelas[nome] || []).map(r => ({ ...r }));
    if (/JOIN tenants/i.test(sql) && nome === 'listings') {
      rows = rows.map(r => {
        const t = (tabelas.tenants || []).find(x => String(x.id) === String(r.tenant_id));
        return { ...r, tenant_nome: t?.nome_exibicao, tenant_sub: t?.subdominio, tenant_plano: t?.plano, tenant_whatsapp: t?.whatsapp, tenant_creci: t?.creci, tenant_logo: t?.logo_url };
      });
    }
    const where = sql.match(/WHERE ([^;]*?)(?: ORDER|$)/i);
    if (where) {
      const cond = where[1];
      const iguals = [...cond.matchAll(/([a-z_.]+)\s*=\s*\?/gi)];
      rows = rows.filter(r => iguals.every((g, gi) => String(r[g[1].split('.').pop()]) === String(this.params[gi])));
      const lits = [...cond.matchAll(/([a-z_.]+)\s*(=|!=)\s*'([^']*)'/gi)];
      rows = rows.filter(r => lits.every(g => {
        const v = r[g[1].split('.').pop()];
        return g[2] === '=' ? String(v) === g[3] : String(v) !== g[3];
      }));
      const likes = [...cond.matchAll(/\(([a-z_.]+) LIKE \?/gi)];
      rows = rows.filter(r => likes.every(g => {
        const p = this.params[g[1].split('.').pop() === 'titulo' ? 0 : 1];
        return true;
      }));
    }
    if (/ORDER BY .* DESC/.test(sql)) rows = rows.reverse();
    const lim = sql.match(/LIMIT (\d+)/i);
    if (lim) rows = rows.slice(0, Number(lim[1]));
    return { results: rows };
  }
}

const DB = { prepare: (sql) => new Stmt(sql) };
const env = {
  DB,
  MEDIA_BUCKET: {
    put: async () => {},
    get: async (key) => {
      const content = key.includes('teste') ? Buffer.from('x') : null;
      return content ? { body: content, writeHttpMetadata: (h) => h.set('content-type', 'image/jpeg'), httpEtag: 'et' } : null;
    },
    delete: async () => {},
  },
  JWT_SECRET: 'segredo-de-teste',
  ASSETS: null,
  INFINITEPAY_API_KEY: 'chave-de-teste-infinitepay',
};

// Mock do gateway InfinitePay
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('api.checkout.infinitepay.io/links')) {
    return new Response(JSON.stringify({ id: 'lnk_teste', slug: 'slug-teste', url: 'https://checkout.infinitepay.io/l/slug-teste' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('api.checkout.infinitepay.io/payment_check')) {
    return new Response(JSON.stringify({ success: true, paid: true, paid_amount: 4990 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return fetchOriginal(url, opts);
};

function req(url, { method = 'GET', body, token } = {}) {
  const headers = new Headers();
  if (body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', 'Bearer ' + token);
  return new Request('https://imobi.test' + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

const passos = [];
function ok(nome, cond) { passos.push((cond ? '✓ ' : '✗ ') + nome); }

const r1 = await worker.fetch(req('/api/health'), env);
ok('health 200', r1.status === 200);

const cad = await worker.fetch(req('/api/auth/cadastro', { method: 'POST', body: { tipo_perfil: 'corretor', nome_exibicao: 'Teste Imóveis', nome: 'Maria', email: 'maria@teste.com', senha: '123456' } }), env);
const cadJson = await cad.json();
ok('cadastro 201 + token', cad.status === 201 && !!cadJson.token);
ok('cadastro retorna tenant', !!cadJson.tenant?.id);

const log = await worker.fetch(req('/api/auth/login', { method: 'POST', body: { email: 'maria@teste.com', senha: '123456' } }), env);
const logJson = await log.json();
ok('login 200 + token', log.status === 200 && !!logJson.token);

const senhaErrada = await worker.fetch(req('/api/auth/login', { method: 'POST', body: { email: 'maria@teste.com', senha: 'errada' } }), env);
ok('login senha errada → 401', senhaErrada.status === 401);

const pub = await worker.fetch(req('/api/listings', { method: 'POST', token: logJson.token, body: { titulo: 'Cobertura 3 qtos', modalidade: 'venda_direta', preco_face: 780000, localizacao: 'Águas Claras', quartos: 3, area_m2: 120, media_urls: [{ tipo: 'foto', url: 'https://imobi.test/media/teste.jpg' }] } }), env);
const pubJson = await pub.json();
ok('publicar 201', pub.status === 201 && !!pubJson.id);

const vit = await worker.fetch(req('/api/listings'), env);
const vitJson = await vit.json();
ok('vitrine mostra 1 imóvel público', vitJson.listings?.length === 1);
ok('vitrine tem mídia vinculada', vitJson.listings?.[0]?.media?.length === 1);
ok('vitrine tem nome da marca', vitJson.listings?.[0]?.tenant_nome === 'Teste Imóveis');

const semToken = await worker.fetch(req('/api/listings', { method: 'POST', body: { titulo: 'x' } }), env);
ok('publicar sem token → 401', semToken.status === 401);

const lead = await worker.fetch(req('/api/leads', { method: 'POST', body: { tenant_id: cadJson.tenant.id, listing_id: pubJson.id, nome: 'João', whatsapp: '61999999999' } }), env);
ok('lead criado 201', lead.status === 201);

const meusLeads = await worker.fetch(req('/api/leads/mine', { token: logJson.token }), env);
const meusLeadsJson = await meusLeads.json();
ok('leads do corretor visíveis', meusLeadsJson.leads?.length === 1);

const mine = await worker.fetch(req('/api/listings/mine', { token: logJson.token }), env);
const mineJson = await mine.json();
ok('meus anúncios 1', mineJson.listings?.length === 1);

const det = await worker.fetch(req(`/api/listings/${pubJson.id}`), env);
ok('detalhe público 200', det.status === 200);

const patch = await worker.fetch(req(`/api/listings/${pubJson.id}`, { method: 'PATCH', token: logJson.token, body: { status: 'inativo' } }), env);
ok('pausar anúncio ok', patch.status === 200);
const vit2 = await worker.fetch(req('/api/listings'), env);
ok('anúncio pausado some da vitrine', (await vit2.json()).listings?.length === 0);

const planos = await worker.fetch(req('/api/planos'), env);
ok('planos 3 cadastrados', (await planos.json()).planos?.length === 3);

const demo = await worker.fetch(req('/api/pagamentos/demo', { method: 'POST', token: logJson.token, body: { plano: 'premium' } }), env);
ok('ativar premium (demo) ok', demo.status === 200);

const fatura = await worker.fetch(req('/api/me/fatura', { token: logJson.token }), env);
const fatJson = await fatura.json();
ok('fatura mostra premium ativo', fatJson.tenant?.plano === 'premium' && fatJson.pagamentos?.length === 1);

const ipay = await worker.fetch(req('/api/pagamentos/infinitepay', { method: 'POST', token: logJson.token, body: { plano: 'profissional' } }), env);
const ipayJson = await ipay.json();
ok('infinitepay cria checkout 201 + url', ipay.status === 201 && !!ipayJson.url && !!ipayJson.order_nsu);

const whDesconhecido = await worker.fetch(req('/api/webhooks/infinitepay', { method: 'POST', body: { order_nsu: 'nao-existe' } }), env);
ok('webhook infinitepay pedido desconhecido → 404', whDesconhecido.status === 404);

const wh = await worker.fetch(req('/api/webhooks/infinitepay', { method: 'POST', body: { order_nsu: ipayJson.order_nsu, transaction_nsu: 'tx-teste', invoice_slug: 'slug-teste' } }), env);
const whJson = await wh.json();
ok('webhook infinitepay confirma e ativa plano', wh.status === 200 && whJson.ativado === true);

const fat2 = await worker.fetch(req('/api/me/fatura', { token: logJson.token }), env);
const fat2Json = await fat2.json();
ok('fatura ativa plano profissional via infinitepay', fat2Json.tenant?.plano === 'profissional' && fat2Json.pagamentos?.length === 2);

console.log(passos.join('\n'));
const falhas = passos.filter(p => p.startsWith('✗')).length;
console.log(falhas === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${falhas} FALHA(S)`);
process.exit(falhas ? 1 : 0);
