// =====================================================================
// IMOBI — API completa (Cloudflare Workers + D1 + R2)
// Sem dependências externas: WebCrypto (PBKDF2 + HMAC-JWT) e fetch nativo.
// O schema do D1 é garantido automaticamente na primeira requisição.
// =====================================================================

const ENC = new TextEncoder();
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

// ---------- Helpers de resposta / CORS ----------
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function erro(c, status, mensagem) {
  return json({ erro: mensagem }, status);
}
function aplicarCors(resp, origin) {
  const h = new Headers(resp.headers);
  h.set("Access-Control-Allow-Origin", origin || "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  h.set("Access-Control-Max-Age", "86400");
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

// ---------- Crypto: senha (PBKDF2) e token (HMAC) ----------
function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.substr(i, 2), 16);
  return out;
}
async function hashSenha(senha) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", ENC.encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return `${toHex(salt)}:${toHex(bits)}`;
}
async function senhaConfere(senha, guardada) {
  try {
    const [sh, hh] = guardada.split(":");
    const key = await crypto.subtle.importKey("raw", ENC.encode(senha), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: fromHex(sh), iterations: 100000, hash: "SHA-256" }, key, 256);
    return toHex(bits) === hh;
  } catch { return false; }
}
const b64url = (str) => btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function assinarToken(payload, secret) {
  const corpo = { ...payload, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 };
  const corpoB64 = b64url(JSON.stringify(corpo));
  const headerB64 = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const key = await crypto.subtle.importKey("raw", ENC.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, ENC.encode(`${headerB64}.${corpoB64}`));
  return `${headerB64}.${corpoB64}.${b64url(String.fromCharCode(...new Uint8Array(sig)))}`;
}
async function validarToken(token, secret) {
  try {
    const [h, p, s] = String(token || "").split(".");
    if (!h || !p || !s) return null;
    const key = await crypto.subtle.importKey("raw", ENC.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, fromHex(b64urlParaHex(s)), ENC.encode(`${h}.${p}`));
    if (!ok) return null;
    const payload = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}
function b64urlParaHex(b64) {
  const pad = b64.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return toHex(new Uint8Array([...bin].map(c => c.charCodeAt(0))));
}
function novoId() { return crypto.randomUUID(); }
function slugify(t) {
  return (t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "marca";
}

// ---------- Schema auto-garantido (idempotente) ----------
async function garantirSchema(env) {
  const criar = (sql) => env.DB.prepare(sql).run();
  const alterar = (sql) => env.DB.prepare(sql).run().catch(() => {});

  // Migra para o lado tabelas do protótipo antigo (sem tenant_id), preservando os dados.
  // O RENAME é inofensivo se a tabela não existir ou já estiver no formato novo.
  const colunaExiste = async (tabela, coluna) => {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM pragma_table_info('${tabela}') WHERE name = '${coluna}'`
    ).first().catch(() => null);
    return !!(r && r.n > 0);
  };
  if (await colunaExiste("users", "email") && !(await colunaExiste("users", "tenant_id"))) {
    await alterar("ALTER TABLE users RENAME TO users_legado");
  }
  if (await colunaExiste("leads", "name") && !(await colunaExiste("leads", "tenant_id"))) {
    await alterar("ALTER TABLE leads RENAME TO leads_legado");
  }
  await alterar("ALTER TABLE properties RENAME TO properties_legado");

  await criar(`CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo_perfil TEXT NOT NULL,
    nome_exibicao TEXT NOT NULL,
    nome TEXT NOT NULL,
    subdominio TEXT UNIQUE,
    logo_url TEXT,
    cor_primaria TEXT DEFAULT '#CDA05F',
    sobre TEXT,
    creci TEXT,
    whatsapp TEXT,
    chave_pix TEXT,
    status_licenca TEXT NOT NULL DEFAULT 'trial',
    plano TEXT NOT NULL DEFAULT 'gratis',
    limite_anuncios INTEGER NOT NULL DEFAULT 3,
    anuncios_publicados INTEGER NOT NULL DEFAULT 0,
    trial_ate TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await criar(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await criar(`CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    titulo TEXT NOT NULL,
    modalidade TEXT NOT NULL CHECK(modalidade IN ('agio','venda_direta','locacao_residencial')),
    tipo_imovel TEXT DEFAULT 'apartamento',
    preco_face INTEGER NOT NULL DEFAULT 0,
    localizacao TEXT,
    quartos INTEGER, banheiros INTEGER, vagas INTEGER, area_m2 REAL,
    agio_pago INTEGER, saldo_devedor INTEGER, prestacao_mensal INTEGER, banco_credor TEXT,
    memorial_descritivo TEXT,
    video_tour_url TEXT,
    status TEXT NOT NULL DEFAULT 'ativo',
    destaque INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await criar(`CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL CHECK(tipo IN ('foto','video')),
    url TEXT NOT NULL,
    ordem INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await criar(`CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    nome TEXT NOT NULL,
    whatsapp TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'novo',
    observacao TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await criar(`CREATE TABLE IF NOT EXISTS planos (
    nome TEXT PRIMARY KEY,
    titulo TEXT NOT NULL,
    preco REAL NOT NULL,
    limite_anuncios INTEGER NOT NULL,
    duracao_dias INTEGER NOT NULL,
    selo INTEGER NOT NULL DEFAULT 0,
    destaque INTEGER NOT NULL DEFAULT 0
  )`);
  await criar(`CREATE TABLE IF NOT EXISTS pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plano TEXT NOT NULL,
    valor REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente',
    asaas_id TEXT,
    pix_copia_cola TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    pago_em DATETIME
  )`);
  await criar(`CREATE INDEX IF NOT EXISTS idx_listings_modalidade ON listings(modalidade)`);
  await criar(`CREATE INDEX IF NOT EXISTS idx_listings_tenant ON listings(tenant_id)`);
  await criar(`CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status)`);
  await criar(`CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id)`);
  await criar(`CREATE INDEX IF NOT EXISTS idx_media_listing ON media(listing_id)`);

  // Colunas novas em bancos que já tinham o schema antigo (0001_inicial.sql)
  await alterar(`ALTER TABLE tenants ADD COLUMN subdominio TEXT`);
  await alterar(`ALTER TABLE tenants ADD COLUMN logo_url TEXT`);
  await alterar(`ALTER TABLE tenants ADD COLUMN cor_primaria TEXT DEFAULT '#CDA05F'`);
  await alterar(`ALTER TABLE tenants ADD COLUMN sobre TEXT`);
  await alterar(`ALTER TABLE tenants ADD COLUMN status_licenca TEXT NOT NULL DEFAULT 'trial'`);
  await alterar(`ALTER TABLE tenants ADD COLUMN plano TEXT NOT NULL DEFAULT 'gratis'`);
  await alterar(`ALTER TABLE tenants ADD COLUMN limite_anuncios INTEGER NOT NULL DEFAULT 3`);
  await alterar(`ALTER TABLE tenants ADD COLUMN anuncios_publicados INTEGER NOT NULL DEFAULT 0`);
  await alterar(`ALTER TABLE tenants ADD COLUMN trial_ate TEXT`);
  await alterar(`ALTER TABLE tenants ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
  await alterar(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'`);
  await alterar(`ALTER TABLE listings ADD COLUMN tipo_imovel TEXT DEFAULT 'apartamento'`);
  await alterar(`ALTER TABLE listings ADD COLUMN quartos INTEGER`);
  await alterar(`ALTER TABLE listings ADD COLUMN banheiros INTEGER`);
  await alterar(`ALTER TABLE listings ADD COLUMN vagas INTEGER`);
  await alterar(`ALTER TABLE listings ADD COLUMN area_m2 REAL`);
  await alterar(`ALTER TABLE listings ADD COLUMN status TEXT NOT NULL DEFAULT 'ativo'`);
  await alterar(`ALTER TABLE listings ADD COLUMN destaque INTEGER NOT NULL DEFAULT 0`);
  await alterar(`ALTER TABLE listings ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
  await alterar(`ALTER TABLE media ADD COLUMN ordem INTEGER NOT NULL DEFAULT 0`);
  await alterar(`ALTER TABLE leads ADD COLUMN status TEXT NOT NULL DEFAULT 'novo'`);
  await alterar(`ALTER TABLE leads ADD COLUMN observacao TEXT`);
  await alterar(`ALTER TABLE pagamentos ADD COLUMN gateway TEXT`);
  await alterar(`ALTER TABLE pagamentos ADD COLUMN order_nsu TEXT`);
  await alterar(`ALTER TABLE pagamentos ADD COLUMN slug TEXT`);
  await alterar(`ALTER TABLE pagamentos ADD COLUMN checkout_url TEXT`);

  // Planos padrão
  const contagem = await env.DB.prepare("SELECT COUNT(*) AS n FROM planos").first();
  if (!contagem || !contagem.n) {
    await env.DB.prepare(`INSERT INTO planos (nome, titulo, preco, limite_anuncios, duracao_dias, selo, destaque) VALUES
      ('gratis','Vitrine gratuita',0,3,30,0,0),
      ('profissional','Profissional',49.90,30,30,1,0),
      ('premium','Premium',99.90,999999,30,1,1)`).run();
  }
}

let schemaPromise = null;
function schemaPronto(env) {
  if (!schemaPromise) schemaPromise = garantirSchema(env).catch(e => { schemaPromise = null; throw e; });
  return schemaPromise;
}

// ---------- Auth ----------
async function authPayload(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  return validarToken(token, env.JWT_SECRET || "imobi-jwt-secret-2026-7d9f4a2b1e8c5d0a3f6b9e2c7d4a1f0b");
}
async function carregarTenant(env, tenantId) {
  return env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(tenantId).first();
}
async function mídiasDoListing(env, listingId) {
  const { results } = await env.DB.prepare(
    "SELECT id, tipo, url, ordem FROM media WHERE listing_id = ? ORDER BY ordem ASC, id ASC"
  ).bind(listingId).all();
  return results || [];
}
function sanitizarNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n !== null && v !== "" && v !== undefined && v !== null ? n : null;
}

// ---------- Asaas (cobrança real via PIX) ----------
async function asaasBase(env) {
  return env.ASAAS_SANDBOX === "true" ? "https://api-sandbox.asaas.com/v3" : "https://api.asaas.com/v3";
}
async function asaasCriarPix(env, tenant, userEmail, plano) {
  const KEY = env.ASAAS_API_KEY;
  if (!KEY) return null;
  const base = await asaasBase(env);
  const headers = { "Content-Type": "application/json", "access_token": KEY };

  // Cliente (reaproveita o tenant como customer)
  const cliResp = await fetch(`${base}/customers?email=${encodeURIComponent(userEmail)}`, { headers });
  let customerId = null;
  if (cliResp.ok) {
    const { data } = await cliResp.json();
    customerId = data && data[0] ? data[0].id : null;
  }
  if (!customerId) {
    const novo = await fetch(`${base}/customers`, {
      method: "POST", headers,
      body: JSON.stringify({ name: tenant.nome_exibicao, email: userEmail, phone: (tenant.whatsapp || "").replace(/\D/g, "") })
    });
    if (!novo.ok) throw new Error("Falha ao criar cliente Asaas.");
    customerId = (await novo.json()).id;
  }

  const hoje = new Date().toISOString().slice(0, 10);
  const cob = await fetch(`${base}/payments`, {
    method: "POST", headers,
    body: JSON.stringify({ customer: customerId, billingType: "PIX", value: plano.preco, dueDate: hoje, description: `IMOBI — Plano ${plano.titulo}` })
  });
  if (!cob.ok) throw new Error("Falha ao criar cobrança PIX.");
  const pagamento = await cob.json();

  const qr = await fetch(`${base}/payments/${pagamento.id}/pixQrCode`, { headers });
  let pix = null;
  if (qr.ok) {
    const d = await qr.json();
    pix = { copiaECola: d.payload, imagem: d.encodedImage };
  }
  return { asaas_id: pagamento.id, pix };
}

// ---------- InfinitePay (checkout integrado: PIX com QR code + cartão) ----------
const INFINITEPAY_API = "https://api.checkout.infinitepay.io";

// O gateway rejeita caracteres fora do ASCII (acentos, travessão) — 400 Bad Request.
function textoAscii(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[—–]/g, "-")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function infinitepayCriarCheckout(env, tenant, userEmail, plano, pagamentoId) {
  const KEY = env.INFINITEPAY_API_KEY;
  if (!KEY) return null;
  const orderNsu = `imobi-pag-${pagamentoId}-${Date.now()}`;
  // O handle precisa estar cadastrado no painel InfinitePay; demais handles retornam 403.
  const handle = env.INFINITEPAY_HANDLE || "droppfy";
  const base = env.INFINITEPAY_WEBHOOK_BASE || "https://imobi-api.contatodroppfy.workers.dev";
  const corpo = {
    handle,
    order_nsu: orderNsu,
    webhook_url: `${base}/api/webhooks/infinitepay`,
    redirect_url: `${base}/api/pagamentos/retorno?order_nsu=${encodeURIComponent(orderNsu)}`,
    items: [{
      quantity: 1,
      price: Math.round(plano.preco * 100),
      description: textoAscii(`IMOBI — Assinatura do plano ${plano.titulo} (30 dias)`),
    }],
    customer: {
      name: textoAscii(tenant.nome_exibicao) || "Cliente",
      email: userEmail,
      phone_number: (tenant.whatsapp || "").replace(/\D/g, ""),
    },
    options: {
      single_payment: true,
      require_delivery_address: false,
      assured_installments: 0,
      payment_methods_enabled: ["pix", "credit_card"],
      valid_until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  };
  const resp = await fetch(`${INFINITEPAY_API}/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": KEY },
    body: JSON.stringify(corpo),
  });
  const texto = await resp.text();
  let dados = null;
  try { dados = JSON.parse(texto); } catch { dados = { bruto: texto }; }
  if (!resp.ok || (dados && dados.success === false)) {
    throw new Error(`InfinitePay respondeu ${resp.status}: ${texto.slice(0, 300)}`);
  }
  const raiz = dados.data && typeof dados.data === "object" ? dados.data : dados;
  const url = dados.url || dados.checkout_url || dados.payment_url || dados.link || raiz.url || raiz.checkout_url || raiz.payment_url || null;
  const slug = dados.slug || dados.invoice_slug || dados.id || raiz.slug || raiz.invoice_slug || raiz.id || null;
  return { order_nsu: orderNsu, handle, slug, url };
}

async function infinitepayChecar(env, { handle, order_nsu, transaction_nsu, slug }) {
  const KEY = env.INFINITEPAY_API_KEY;
  if (!KEY) return null;
  const resp = await fetch(`${INFINITEPAY_API}/payment_check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": KEY },
    body: JSON.stringify({ handle, order_nsu, transaction_nsu: transaction_nsu || null, slug: slug || null }),
  });
  if (!resp.ok) return null;
  return await resp.json().catch(() => null);
}

// ---------- Ativação de plano ----------
async function ativarPlano(env, tenantId, planoNome) {
  const plano = await env.DB.prepare("SELECT * FROM planos WHERE nome = ?").bind(planoNome).first();
  if (!plano) throw new Error("Plano inválido.");
  await env.DB.prepare(
    `UPDATE tenants SET plano = ?, limite_anuncios = ?, status_licenca = 'ativo', trial_ate = NULL, updated_at = datetime('now') WHERE id = ?`
  ).bind(planoNome, plano.limite_anuncios, tenantId).run();
  return plano;
}

// =====================================================================
// ROTEADOR PRINCIPAL
// =====================================================================
export default {
  async fetch(request, env) {
    await schemaPronto(env).catch(() => {});
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const origin = request.headers.get("Origin") || "*";

    const comCors = (r) => aplicarCors(r, origin);

    // Preflight CORS
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      }});
    }

    try {
      // ===================== HEALTH / STATS =====================
      if (path === "/api/health" && method === "GET") {
        return comCors(json({ ok: true, servico: "imobi-api", hora: new Date().toISOString() }));
      }
      if (path === "/api/stats" && method === "GET") {
        const [l, t, le] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS n FROM listings WHERE status = 'ativo'").first(),
          env.DB.prepare("SELECT COUNT(*) AS n FROM tenants").first(),
          env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first(),
        ]);
        return comCors(json({ imoveis: l.n || 0, corretores: t.n || 0, leads: le.n || 0 }));
      }

      // ===================== PLANOS =====================
      if (path === "/api/planos" && method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM planos ORDER BY preco ASC").all();
        return comCors(json({ planos: results }));
      }

      // ===================== AUTH =====================
      if (path === "/api/auth/cadastro" && method === "POST") {
        const b = await request.json().catch(() => null);
        if (!b) return comCors(erro(request, 400, "Corpo JSON inválido."));
        const { tipo_perfil, nome_exibicao, nome, creci, whatsapp, chave_pix, email, senha } = b;
        if (!tipo_perfil || !nome_exibicao || !nome || !email || !senha) {
          return comCors(erro(request, 400, "Preencha os campos obrigatórios: tipo de perfil, nome, e-mail e senha."));
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return comCors(erro(request, 400, "E-mail inválido."));
        if (String(senha).length < 6) return comCors(erro(request, 400, "A senha deve ter pelo menos 6 caracteres."));

        const existente = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
        if (existente) return comCors(erro(request, 409, "E-mail já cadastrado."));

        let sub = slugify(nome_exibicao);
        if (await env.DB.prepare("SELECT id FROM tenants WHERE subdominio = ?").bind(sub).first()) {
          sub = `${sub}-${Math.floor(Math.random() * 900 + 100)}`;
        }

        const tenant = await env.DB.prepare(
          `INSERT INTO tenants (tipo_perfil, nome_exibicao, nome, subdominio, creci, whatsapp, chave_pix, trial_ate)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+30 days')) RETURNING id`
        ).bind(tipo_perfil, nome_exibicao, nome, sub, creci || null, whatsapp || null, chave_pix || null).first();

        const password_hash = await hashSenha(senha);
        const user = await env.DB.prepare(
          "INSERT INTO users (tenant_id, email, password_hash) VALUES (?, ?, ?) RETURNING id"
        ).bind(tenant.id, email, password_hash).first();

        const token = await assinarToken({ sub: String(user.id), tenant_id: tenant.id, email }, env.JWT_SECRET || "imobi-jwt-secret-2026-7d9f4a2b1e8c5d0a3f6b9e2c7d4a1f0b");
        return comCors(json({
          token,
          user: { id: user.id, email, nome },
          tenant: { id: tenant.id, nome_exibicao, tipo_perfil, subdominio: sub, plano: "gratis", status_licenca: "trial", limite_anuncios: 3 },
        }, 201));
      }

      if (path === "/api/auth/login" && method === "POST") {
        const b = await request.json().catch(() => null);
        if (!b || !b.email || !b.senha) return comCors(erro(request, 400, "E-mail e senha são obrigatórios."));
        const row = await env.DB.prepare(
          `SELECT u.id, u.tenant_id, u.email, u.password_hash, u.role,
                  t.nome_exibicao, t.tipo_perfil, t.nome, t.subdominio, t.plano, t.status_licenca, t.limite_anuncios
           FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = ?`
        ).bind(b.email).first();
        if (!row || !(await senhaConfere(b.senha, row.password_hash))) {
          return comCors(erro(request, 401, "Credenciais inválidas."));
        }
        const token = await assinarToken({ sub: String(row.id), tenant_id: row.tenant_id, email: row.email, role: row.role }, env.JWT_SECRET || "imobi-jwt-secret-2026-7d9f4a2b1e8c5d0a3f6b9e2c7d4a1f0b");
        return comCors(json({
          token,
          user: { id: row.id, email: row.email, nome: row.nome },
          tenant: { id: row.tenant_id, nome_exibicao: row.nome_exibicao, tipo_perfil: row.tipo_perfil, subdominio: row.subdominio, plano: row.plano, status_licenca: row.status_licenca, limite_anuncios: row.limite_anuncios },
        }));
      }

      if (path === "/api/auth/me" && method === "GET") {
        const auth = await authPayload(request, env);
        if (!auth) return comCors(erro(request, 401, "Não autenticado."));
        const tenant = await carregarTenant(env, auth.tenant_id);
        if (!tenant) return comCors(erro(request, 404, "Conta não encontrada."));
        return comCors(json({ auth, tenant }));
      }

      // ===================== PERFIL / MARCA =====================
      if (path === "/api/tenant/me" && method === "PATCH") {
        const auth = await authPayload(request, env);
        if (!auth) return comCors(erro(request, 401, "Não autenticado."));
        const b = await request.json().catch(() => null);
        if (!b) return comCors(erro(request, 400, "Corpo JSON inválido."));
        const campos = ["nome_exibicao", "nome", "creci", "whatsapp", "chave_pix", "sobre", "logo_url", "cor_primaria"];
        const sets = [], vals = [];
        for (const c of campos) {
          if (b[c] !== undefined) { sets.push(`${c} = ?`); vals.push(b[c] === "" ? null : b[c]); }
        }
        if (sets.length) {
          vals.push(auth.tenant_id);
          await env.DB.prepare(`UPDATE tenants SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).bind(...vals).run();
        }
        const tenant = await carregarTenant(env, auth.tenant_id);
        return comCors(json({ tenant }));
      }

      if (path.startsWith("/api/tenants/") && method === "GET") {
        const sub = path.split("/")[3];
        const tenant = await env.DB.prepare(
          "SELECT id, tipo_perfil, nome_exibicao, subdominio, logo_url, cor_primaria, sobre, creci, whatsapp, created_at FROM tenants WHERE subdominio = ?"
        ).bind(sub).first();
        if (!tenant) return comCors(erro(request, 404, "Marca não encontrada."));
        const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM listings WHERE tenant_id = ? AND status = 'ativo'").bind(tenant.id).first() || { n: 0 };
        return comCors(json({ tenant: { ...tenant, anuncios: results.n } }));
      }

      // ===================== LISTINGS (público) =====================
      if (path === "/api/listings" && method === "GET") {
        const modalidade = url.searchParams.get("modalidade") || "todas";
        const q = (url.searchParams.get("q") || "").trim();
        const tipo = url.searchParams.get("tipo") || "";
        const ordenar = url.searchParams.get("ordenar") || "recentes";

        let sql = `SELECT l.*, t.nome_exibicao AS tenant_nome, t.subdominio AS tenant_sub, t.plano AS tenant_plano,
                          t.whatsapp AS tenant_whatsapp, t.creci AS tenant_creci, t.logo_url AS tenant_logo
                   FROM listings l JOIN tenants t ON t.id = l.tenant_id
                   WHERE l.status = 'ativo'`;
        const params = [];
        if (modalidade !== "todas") { sql += " AND l.modalidade = ?"; params.push(modalidade); }
        if (tipo) { sql += " AND l.tipo_imovel = ?"; params.push(tipo); }
        if (q) {
          sql += " AND (l.titulo LIKE ? OR l.localizacao LIKE ? OR l.memorial_descritivo LIKE ?)";
          params.push(`%${q}%`, `%${q}%`, `%${q}%`);
        }
        if (ordenar === "preco") sql += " ORDER BY l.preco_face ASC";
        else if (ordenar === "destaque") sql += " ORDER BY l.destaque DESC, l.created_at DESC";
        else sql += " ORDER BY l.destaque DESC, l.created_at DESC";

        const { results } = await env.DB.prepare(sql).bind(...params).all();
        const listings = [];
        for (const l of results || []) {
          l.media = await mídiasDoListing(env, l.id);
          listings.push(l);
        }
        return comCors(json({ listings }));
      }

      if (path === "/api/listings/mine" && method === "GET") {
        const auth = await authPayload(request, env);
        if (!auth) return comCors(erro(request, 401, "Não autenticado."));
        const { results } = await env.DB.prepare(
          "SELECT * FROM listings WHERE tenant_id = ? ORDER BY created_at DESC"
        ).bind(auth.tenant_id).all();
        const listings = [];
        for (const l of results || []) {
          l.media = await mídiasDoListing(env, l.id);
          listings.push(l);
        }
        return comCors(json({ listings }));
      }

      if (path.startsWith("/api/listings/") && method === "GET") {
        const id = Number(path.split("/")[3]);
        if (!id) return comCors(erro(request, 404, "Imóvel não encontrado."));
        const l = await env.DB.prepare(
          `SELECT l.*, t.nome_exibicao AS tenant_nome, t.subdominio AS tenant_sub, t.plano AS tenant_plano,
                  t.whatsapp AS tenant_whatsapp, t.creci AS tenant_creci, t.logo_url AS tenant_logo, t.sobre AS tenant_sobre
           FROM listings l JOIN tenants t ON t.id = l.tenant_id WHERE l.id = ? AND l.status = 'ativo'`
        ).bind(id).first();
        if (!l) return comCors(erro(request, 404, "Imóvel não encontrado."));
        l.media = await mídiasDoListing(env, l.id);
        return comCors(json({ listing: l }));
      }

      // ===================== LISTINGS (autenticado) =====================
      if (path === "/api/listings" && method === "POST") {
        const auth = await authPayload(request, env);
        if (!auth) return comCors(erro(request, 401, "Não autenticado."));

        const tenant = await carregarTenant(env, auth.tenant_id);
        if (!tenant) return comCors(erro(request, 404, "Conta não encontrada."));
        if (tenant.status_licenca === "suspenso") return comCors(erro(request, 402, "Conta suspensa. Regularize seu plano para publicar."));
        if (tenant.anuncios_publicados >= tenant.limite_anuncios) {
          return comCors(erro(request, 402, `Limite de ${tenant.limite_anuncios} anúncios atingido no plano atual. Faça upgrade para publicar mais imóveis.`));
        }

        const b = await request.json().catch(() => null);
        if (!b) return comCors(erro(request, 400, "Corpo JSON inválido."));
        const obrigatorios = ["titulo", "modalidade", "preco_face", "localizacao"];
        for (const f of obrigatorios) {
          if (b[f] === undefined || b[f] === "" || b[f] === null) {
            return comCors(erro(request, 400, `Campo obrigatório: ${f}.`));
          }
        }
        if (!["agio", "venda_direta", "locacao_residencial"].includes(b.modalidade)) {
          return comCors(erro(request, 400, "Modalidade inválida."));
        }

        const listing = await env.DB.prepare(
          `INSERT INTO listings (tenant_id, titulo, modalidade, tipo_imovel, preco_face, localizacao,
             quartos, banheiros, vagas, area_m2, agio_pago, saldo_devedor, prestacao_mensal, banco_credor,
             memorial_descritivo, video_tour_url, destaque)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
        ).bind(
          auth.tenant_id, String(b.titulo).slice(0, 140), b.modalidade, b.tipo_imovel || "apartamento",
          Number(b.preco_face) || 0, String(b.localizacao || "").slice(0, 160),
          sanitizarNum(b.quartos), sanitizarNum(b.banheiros), sanitizarNum(b.vagas), sanitizarNum(b.area_m2),
          sanitizarNum(b.agio_pago), sanitizarNum(b.saldo_devedor), sanitizarNum(b.prestacao_mensal),
          b.banco_credor || null, b.memorial_descritivo || null, b.video_tour_url || null,
          tenant.plano === "premium" ? 1 : 0
        ).first();

        if (Array.isArray(b.media_urls) && b.media_urls.length) {
          let ordem = 0;
          for (const m of b.media_urls) {
            if (!m || !m.url) continue;
            await env.DB.prepare(
              "INSERT INTO media (listing_id, tenant_id, tipo, url, ordem) VALUES (?, ?, ?, ?, ?)"
            ).bind(listing.id, auth.tenant_id, m.tipo === "video" ? "video" : "foto", m.url, ordem++).run();
          }
        }

        await env.DB.prepare(
          "UPDATE tenants SET anuncios_publicados = anuncios_publicados + 1, updated_at = datetime('now') WHERE id = ?"
        ).bind(auth.tenant_id).run();

        return comCors(json({ id: listing.id, ok: true }, 201));
      }

      if (path.startsWith("/api/listings/") && method === "PATCH") {
        const auth = await authPayload(request, env);
        if (!auth) return comCors(erro(request, 401, "Não autenticado."));
        const id = Number(path.split("/")[3]);
        const b = await request.json().catch(() => null);
        if (!b) return comCors(erro(request, 400, "Corpo JSON inválido."));

        const atual = await env.DB.prepare("SELECT * FROM listings WHERE id = ? AND tenant_id = ?").bind(id, auth.tenant_id).first();
        if (!atual) return comCors(erro(request, 404, "Anúncio não encontrado."));

        const campos = ["titulo", "modalidade", "tipo_imovel", "preco_face", "localizacao", "quartos", "banheiros",
                        "vagas", "area_m2", "agio_pago", "saldo_devedor", "prestacao_mensal", "banco_credor",
                        "memorial_descritivo", "video_tour_url", "status"];
        const sets = [], vals = [];
        for (const c of campos) {
          if (b[c] !== undefined) { sets.push(`${c} = ?`); vals.push(b[c] === "" ? null : b[c]); }
        }
        if (sets.length) {
          sets.push("updated_at = datetime('now')");
          vals.push(id, auth.tenant_id);
          await env.DB.prepare(`UPDATE listings SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`).bind(...vals).run();
        }

        if (Array.isArray(b.media_urls) && b.media_urls.length) {
          const existentes = await env.DB.prepare("SELECT COUNT(*) AS n FROM media WHERE listing_id = ?").bind(id).first() || { n: 0 };
          let ordem = existentes.n || 0;
          for (const m of b.media_urls) {
            if (!m || !m.url) continue;
            await env.DB.prepare(
              "INSERT INTO media (listing_id, tenant_id, tipo, url, ordem) VALUES (?, ?, ?, ?, ?)"
            ).bind(id, auth.tenant_id, m.tipo === "video" ? "video" : "foto", m.url, ordem++).run();
          }
        }

        const listing = await env.DB.prepare("SELECT * FROM listings WHERE id = ?").bind(id).first();
        listing.media = await mídiasDoListing(env, id);
        return comCors(json({ listing, ok: true }));
      }

      if (path.startsWith("/api/listings/") && method === "DELETE") {
        const auth = await authPayload(request, env);
        if (!auth) return comCors(erro(request, 401, "Não autenticado."));
        const id = Number(path.split("/")[3]);
        const atual = await env.DB.prepare("SELECT * FROM listings WHERE id = ? AND tenant_id = ?").bind(id, auth.tenant_id).first();
        if (!atual) return comCors(erro(request, 404, "Anúncio não encontrado."));

        await env.DB.prepare("UPDATE listings SET status = 'inativo', updated_at = datetime('now') WHERE id = ?").bind(id).run();
        if (atual.status === "ativo") {
          await env.DB.prepare(
            "UPDATE tenants SET anuncios_publicados = MAX(0, anuncios_publicados - 1) WHERE id = ?"
          ).bind(auth.tenant_id).run();
        }
        return comCors(json({ ok: true }));
      }

      // ===================== MÍDIA =====================
      if (path === "/api/media/upload" && method === "POST") {
        const auth = await authPayload(request, env);
        if (!auth) return comCors(erro(request, 401, "Não autenticado."));
        if (!env.MEDIA_BUCKET) return comCors(erro(request, 501, "Armazenamento R2 não configurado."));

        const form = await request.formData().catch(() => null);
        const file = form && form.get("file");
        if (!file || typeof file === "string") return comCors(erro(request, 400, "Nenhum arquivo enviado."));
        if (file.size > 150 * 1024 * 1024) return comCors(erro(request, 413, "Arquivo acima de 150 MB."));

        const ehVideo = file.type.startsWith("video");
        const ehFoto = file.type.startsWith("image");
        if (!ehVideo && !ehFoto) return comCors(erro(request, 415, "Envie apenas fotos ou vídeos."));

        const ext = (file.name.split(".").pop() || (ehVideo ? "mp4" : "jpg")).toLowerCase().replace(/[^a-z0-9]/g, "");
        const key = `${auth.tenant_id}/${novoId()}.${ext}`;
        await env.MEDIA_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: file.type || (ehVideo ? "video/mp4" : "image/jpeg") } });

        return comCors(json({
          url: `${url.origin}/media/${key}`,
          tipo: ehVideo ? "video" : "foto",
          key,
        }, 201));
      }

      if (path.startsWith("/api/media/") && method === "DELETE") {
        const auth = await authPayload(request, env);
        if (!auth) return comCors(erro(request, 401, "Não autenticado."));
        const id = Number(path.split("/")[3]);
        const m = await env.DB.prepare("SELECT * FROM media WHERE id = ? AND tenant_id = ?").bind(id, auth.tenant_id).first();
        if (!m) return comCors(erro(request, 404, "Mídia não encontrada."));
        await env.DB.prepare("DELETE FROM media WHERE id = ?").bind(id).run();
        try {
          const key = decodeURIComponent(m.url.split("/media/")[1] || "");
          if (key && env.MEDIA_BUCKET) await env.MEDIA_BUCKET.delete(key);
        } catch {}
        return comCors(json({ ok: true }));
      }

      // ===================== LEADS =====================
      if (path === "/api/leads" && method === "POST") {
        const b = await request.json().catch(() => null);
        if (!b) return comCors(erro(request, 400, "Corpo JSON inválido."));
        const { tenant_id, listing_id, nome, whatsapp } = b;
        if (!tenant_id || !nome || !whatsapp) return comCors(erro(request, 400, "Dados incompletos: nome e WhatsApp são obrigatórios."));
        await env.DB.prepare(
          "INSERT INTO leads (tenant_id, listing_id, nome, whatsapp) VALUES (?, ?, ?, ?)"
        ).bind(tenant_id, listing_id || null, String(nome).slice(0, 120), String(whatsapp).slice(0, 30)).run();
        return comCors(json({ ok: true }, 201));
      }

      if (path === "/api/leads/mine" && method === "GET") {
        const auth = await authPayload(request, env);
        if (!auth) return comCors(erro(request, 401, "Não autenticado."));
        const { results } = await env.DB.prepare(
          `SELECT le.*, l.titulo AS listing_titulo FROM leads le
           LEFT JOIN listings l ON l.id = le.listing_id
           WHERE le.tenant_id = ? ORDER BY le.created_at DESC`
        ).bind(auth.tenant_id).all();
        return comCors(json({ leads: results || [] }));
      }

      if (path.startsWith("/api/leads/") && method === "PATCH") {
        const auth = await authPayload(request, env);
        if (!auth) return comCors(erro(request, 401, "Não autenticado."));
        const id = Number(path.split("/")[3]);
        const b = await request.json().catch(() => null);
        if (!b) return comCors(erro(request, 400, "Corpo JSON inválido."));
        const info = await env.DB.prepare(
          "UPDATE leads SET status = ?, observacao = ? WHERE id = ? AND tenant_id = ?"
        ).bind(b.status || "novo", b.observacao || null, id, auth.tenant_id).run();
        if (!info.meta.changes) return comCors(erro(request, 404, "Lead não encontrado."));
        return comCors(json({ ok: true }));
      }

      if (path.startsWith("/api/leads/") && method === "DELETE") {
        const auth = await authPayload(request, env);
        if (!auth) return comCors(erro(request, 401, "Não autenticado."));
        const id = Number(path.split("/")[3]);
        await env.DB.prepare("DELETE FROM leads WHERE id = ? AND tenant_id = ?").bind(id, auth.tenant_id).run();
        return comCors(json({ ok: true }));
      }

      // ===================== COBRANÇA / PLANOS =====================
      if (path === "/api/me/fatura" && method === "GET") {
        const auth = await authPayload(request, env);
        if (!auth) return comCors(erro(request, 401, "Não autenticado."));
        const tenant = await carregarTenant(env, auth.tenant_id);
        const { results } = await env.DB.prepare(
          "SELECT * FROM pagamentos WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 20"
        ).bind(auth.tenant_id).all();
        return comCors(json({ tenant, pagamentos: results || [] }));
      }

      if (path === "/api/pagamentos/pix" && method === "POST") {
        const auth = await authPayload(request, env);
        if (!auth) return comCors(erro(request, 401, "Não autenticado."));
        const b = await request.json().catch(() => null);
        if (!b || !b.plano) return comCors(erro(request, 400, "Informe o plano desejado."));
        const plano = await env.DB.prepare("SELECT * FROM planos WHERE nome = ? AND nome != 'gratis'").bind(b.plano).first();
        if (!plano) return comCors(erro(request, 400, "Plano inválido."));

        const tenant = await carregarTenant(env, auth.tenant_id);
        const user = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(auth.sub).first();

        let asaas = null;
        try { asaas = await asaasCriarPix(env, tenant, user ? user.email : auth.email, plano); } catch (e) {
          return comCors(erro(request, 502, `Erro no gateway de pagamento: ${e.message}`));
        }

        if (!asaas) {
          return comCors(json({
            demo: true,
            mensagem: "Gateway de pagamento ainda não configurado. Use o modo demonstração para ativar o plano."
          }));
        }

        await env.DB.prepare(
          "INSERT INTO pagamentos (tenant_id, plano, valor, status, asaas_id, pix_copia_cola) VALUES (?, ?, ?, 'pendente', ?, ?)"
        ).bind(auth.tenant_id, plano.nome, plano.preco, asaas.asaas_id, asaas.pix ? asaas.pix.copiaECola : null).run();

        return comCors(json({ asaas_id: asaas.asaas_id, pix: asaas.pix }, 201));
      }

      if (path === "/api/pagamentos/infinitepay" && method === "POST") {
        const auth = await authPayload(request, env);
        if (!auth) return comCors(erro(request, 401, "Não autenticado."));
        const b = await request.json().catch(() => null);
        if (!b || !b.plano) return comCors(erro(request, 400, "Informe o plano desejado."));
        const plano = await env.DB.prepare("SELECT * FROM planos WHERE nome = ? AND nome != 'gratis'").bind(b.plano).first();
        if (!plano) return comCors(erro(request, 400, "Plano inválido."));

        if (!env.INFINITEPAY_API_KEY) {
          return comCors(json({
            demo: true,
            mensagem: "Gateway de pagamento ainda não configurado. Use o modo demonstração para ativar o plano."
          }));
        }

        const tenant = await carregarTenant(env, auth.tenant_id);
        const user = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(auth.sub).first();
        const email = user ? user.email : auth.email;

        const criado = await env.DB.prepare(
          "INSERT INTO pagamentos (tenant_id, plano, valor, status, gateway) VALUES (?, ?, ?, 'pendente', 'infinitepay') RETURNING id"
        ).bind(auth.tenant_id, plano.nome, plano.preco).first();
        if (!criado || !criado.id) return comCors(erro(request, 500, "Não foi possível registrar o pedido de pagamento."));

        let checkout = null;
        try {
          checkout = await infinitepayCriarCheckout(env, tenant, email, plano, criado.id);
        } catch (e) {
          return comCors(erro(request, 502, `Erro no gateway de pagamento: ${e.message}`));
        }

        await env.DB.prepare(
          "UPDATE pagamentos SET order_nsu = ?, slug = ?, checkout_url = ? WHERE id = ?"
        ).bind(checkout.order_nsu, checkout.slug, checkout.url, criado.id).run();

        return comCors(json({
          id: criado.id,
          order_nsu: checkout.order_nsu,
          url: checkout.url,
          handle: checkout.handle,
          mensagem: "Abra o link para pagar com PIX (QR code) ou cartão. A assinatura é ativada automaticamente após a confirmação."
        }, 201));
      }

      if (path === "/api/webhooks/infinitepay" && method === "POST") {
        const b = await request.json().catch(() => null);
        if (!b || !b.order_nsu) return comCors(json({ ok: false, motivo: "order_nsu ausente" }), 400);
        const pag = await env.DB.prepare("SELECT * FROM pagamentos WHERE order_nsu = ?").bind(b.order_nsu).first();
        if (!pag) return comCors(json({ ok: false, motivo: "pedido desconhecido" }, 404));
        if (pag.status === "pago") return comCors(json({ ok: true, ja_pago: true }));

        // Não confia só no corpo do webhook: confirma o status no gateway.
        const conf = await infinitepayChecar(env, {
          handle: b.handle || env.INFINITEPAY_HANDLE || "droppfy",
          order_nsu: b.order_nsu,
          transaction_nsu: b.transaction_nsu || null,
          slug: b.invoice_slug || b.slug || pag.slug || null,
        });
        const confirmado = !!conf && (
          conf.success === true || conf.paid === true ||
          conf.status === "paid" || conf.status === "confirmed" || conf.status === "approved"
        );
        const valorOk = !conf || !conf.paid_amount ||
          Number(conf.paid_amount || conf.amount || 0) >= Math.round(pag.valor * 100);

        if (confirmado && valorOk) {
          await env.DB.prepare("UPDATE pagamentos SET status = 'pago', pago_em = datetime('now') WHERE id = ?").bind(pag.id).run();
          await ativarPlano(env, pag.tenant_id, pag.plano);
          return comCors(json({ ok: true, ativado: true }));
        }
        return comCors(json({ ok: true, ativado: false }));
      }

      if (path === "/api/pagamentos/retorno" && method === "GET") {
        return Response.redirect("https://imobi.droppfy.com/?pagamento=concluido#painel", 302);
      }

      if (path === "/api/pagamentos/demo" && method === "POST") {
        const auth = await authPayload(request, env);
        if (!auth) return comCors(erro(request, 401, "Não autenticado."));
        const b = await request.json().catch(() => null);
        if (!b || !b.plano) return comCors(erro(request, 400, "Informe o plano desejado."));
        const plano = await env.DB.prepare("SELECT * FROM planos WHERE nome = ? AND nome != 'gratis'").bind(b.plano).first();
        if (!plano) return comCors(erro(request, 400, "Plano inválido."));

        await env.DB.prepare(
          "INSERT INTO pagamentos (tenant_id, plano, valor, status, pago_em) VALUES (?, ?, ?, 'pago', datetime('now'))"
        ).bind(auth.tenant_id, plano.nome, plano.preco).run();
        await ativarPlano(env, auth.tenant_id, plano.nome);
        return comCors(json({ ok: true, mensagem: `Plano ${plano.titulo} ativado (modo demonstração).` }));
      }

      if (path === "/api/webhooks/asaas" && method === "POST") {
        const b = await request.json().catch(() => null);
        if (!b || !b.payment) return comCors(json({ ok: false }), 400);
        const { id: asaasId, status: statusAsaas, value } = b.payment;
        if (statusAsaas === "CONFIRMED" || statusAsaas === "RECEIVED") {
          const pag = await env.DB.prepare("SELECT * FROM pagamentos WHERE asaas_id = ?").bind(asaasId).first();
          if (pag && pag.status !== "pago") {
            await env.DB.prepare("UPDATE pagamentos SET status = 'pago', pago_em = datetime('now') WHERE id = ?").bind(pag.id).run();
            await ativarPlano(env, pag.tenant_id, pag.plano);
          }
        }
        return comCors(json({ ok: true }));
      }

      // ===================== MÍDIA PÚBLICA (R2) =====================
      if (path.startsWith("/media/") && method === "GET") {
        if (!env.MEDIA_BUCKET) return comCors(erro(request, 404, "Mídia não encontrada."));
        const key = decodeURIComponent(path.slice("/media/".length));
        const obj = await env.MEDIA_BUCKET.get(key);
        if (!obj) return comCors(erro(request, 404, "Mídia não encontrada."));
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(obj.body, { headers });
      }

      // ===================== ESTÁTICO (quando o worker serve o site) =====================
      if (env.ASSETS && method === "GET") {
        const resp = await env.ASSETS.fetch(request);
        if (resp.status === 404) {
          const index = await env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
          if (index.ok) {
            const h = new Headers(index.headers);
            h.set("Access-Control-Allow-Origin", "*");
            return new Response(index.body, { status: 200, headers: h });
          }
        }
        return resp;
      }

      return comCors(erro(request, 404, "Rota não encontrada."));
    } catch (err) {
      return comCors(json({ erro: "Erro interno.", detalhe: String(err && err.message ? err.message : err) }, 500));
    }
  },
};
