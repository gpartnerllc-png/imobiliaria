# Contexto do projeto — IMOBI

## O que é
IMOBI é uma vitrine imobiliária multi-marca para o Distrito Federal e entorno.
Corretores, imobiliárias, construtoras, incorporadoras, correspondentes Caixa e proprietários
publicam imóveis (venda, ágio, locação) em uma vitrine única. Cada marca tem conta própria,
pasta de mídia própria, leads próprios e PIX de recebimento próprio — mas todos os imóveis
aparecem para todos os visitantes em qualquer máquina.

## Arquitetura (versão atual)
- `worker/src/index.js` — API completa em JavaScript puro (sem dependências, sem build).
  - Banco: Cloudflare D1 (`imobi`, id 7c48829c-2ab6-4d5b-ba5a-5406badac79b). O D1 antigo
    (`imobiliaria`, 0d2e89e3...) está abandonado — não usar.
  - Mídia: Cloudflare R2 (`imobi-media`, binding `MEDIA_BUCKET`), servida via `/media/:key`.
  - Auth: JWT próprio (WebCrypto HMAC-SHA256) + senhas PBKDF2 (100k iterações — máximo
    suportado pelo runtime Workers; acima disso dá `Pbkdf2 failed`).
  - Schema auto-migratório: `garantirSchema(env)` roda CREATE TABLE IF NOT EXISTS +
    ALTER TABLE idempotentes na primeira requisição. **Não use `wrangler d1 migrations apply`** —
    o schema se auto-corrige e migrations gerariam colunas duplicadas.
  - Planos: gratis (3 anúncios) / profissional (R$49,90, 30) / premium (R$99,90, ilimitado).
  - Cobrança: InfinitePay (gateway ativo — `INFINITEPAY_API_KEY` em secret, nunca no código;
    handle cadastrado `droppfy`; webhook `/api/webhooks/infinitepay`) + fallback
    `POST /api/pagamentos/demo` para ativar plano em modo demonstração.
- `index.html` (raiz) — SPA completa em vanilla JS. É o mesmo arquivo servido pelo
  **GitHub Pages** (`imobi.droppfy.com`, via arquivo `CNAME` na raiz — NÃO é Cloudflare Pages;
  a zona `droppfy.com` não está na conta Cloudflare, então Workers Routes/functions não funcionam lá)
  e copiado para `frontend/index.html` (assets do worker `imobiliada`). Manter os dois em sincronia.
  - Resolve a API dinamicamente: tenta `/api/health` na mesma origem; depois
    `https://imobiliada.contatodroppfy.workers.dev` e `https://imobi-api.contatodroppfy.workers.dev`.
    O worker `imobiliada` roda o MESMO `src/index.js` (API completa + assets) e é o host preferido —
    navegadores de alguns usuários não alcançam `imobi-api.contatodroppfy.workers.dev` (bloqueio
    intermitente a subdomínios workers.dev).
  - `chamarApi` normaliza URLs absolutas antigas (`imobi-api`/`imobiliada`) para a base ativa,
    para fotos antigas carregarem.

## Rotas da API
- `GET /api/health`, `GET /api/stats`, `GET /api/planos`
- `POST /api/auth/cadastro`, `POST /api/auth/login`, `GET /api/auth/me`
- `PATCH /api/tenant/me`, `GET /api/tenants/:sub`
- `GET /api/listings` (público, filtros `modalidade`/`q`/`tipo`/`ordenar`)
- `GET /api/listings/mine`, `GET /api/listings/:id`
- `POST /api/listings` (checa limite do plano → 402), `PATCH`/`DELETE /api/listings/:id`
- `POST /api/media/upload` (até 150 MB, foto/vídeo), `DELETE /api/media/:id`
- `POST /api/leads`, `GET /api/leads/mine`, `PATCH`/`DELETE /api/leads/:id`
- `GET /api/me/fatura`, `POST /api/pagamentos/pix`, `POST /api/pagamentos/demo`,
  `POST /api/webhooks/asaas`

## Workers Cloudflare
- `imobi-api` — API (config: `worker/wrangler.toml`).
- `imobiliada` — serve o site (assets de `frontend/`) (config: `worker/wrangler.imobiliada.toml`).
- O dashboard: https://dash.cloudflare.com/533aa092c7f3571e13fdc103ba716bdf

## CI/CD
- `.github/workflows/deploy-worker.yml` — no push em `main`, faz deploy apenas do `imobi-api`
  (usa o `wrangler.toml` padrão de `worker/`). O token OAuth do GitHub **não tem escopo
  `workflow`** — não é possível editar o arquivo do workflow (push é rejeitado).
- O worker `imobiliada` (site com assets) é feito via `npx wrangler deploy -c wrangler.imobiliada.toml`
  a partir desta máquina (OAuth local). O **GitHub Pages** atualiza `imobi.droppfy.com` pelo
  `index.html` da raiz no push em `main` (deploy automático do Pages do GitHub).

## Secrets necessários
- GitHub Actions: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (já configurados).
- Cloudflare Workers (`wrangler secret put`): `JWT_SECRET` (fallback em código é só para dev),
  `ASAAS_API_KEY` (chave de produção; sem ela, cobrança opera em modo demo).

## Testes locais
```bash
node validar.mjs   # valida sintaxe do frontend e carrega o módulo do worker
node testar.mjs    # 20 testes de fumaça com D1/R2 mockados em memória
```
`testar.mjs` usa um mock SQLite-like mínimo — não cobre SQL complexo, mas valida o fluxo
completo (cadastro → login → publicar → vitrine → leads → planos → ativação).

## Regras de estilo
- JavaScript puro no worker (sem build). Frontend vanilla (sem frameworks).
- Nunca embutir chaves/segredos no código (Asaas, JWT de produção) — usar secrets.
- Manter `index.html` e `frontend/index.html` idênticos.
- Nunca logar senhas ou tokens.
