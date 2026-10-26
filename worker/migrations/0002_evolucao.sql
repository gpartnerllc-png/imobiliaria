-- Evolução do schema — planos, cobrança e campos profissionais.
-- O worker aplica este mesmo schema automaticamente ao iniciar
-- (garantirSchema em src/index.js), então esta migração serve para
-- versionar e recriar o banco do zero.

-- Novos campos em tenants (marca)
ALTER TABLE tenants ADD COLUMN subdominio TEXT;
ALTER TABLE tenants ADD COLUMN logo_url TEXT;
ALTER TABLE tenants ADD COLUMN cor_primaria TEXT DEFAULT '#CDA05F';
ALTER TABLE tenants ADD COLUMN sobre TEXT;
ALTER TABLE tenants ADD COLUMN status_licenca TEXT NOT NULL DEFAULT 'trial';
ALTER TABLE tenants ADD COLUMN plano TEXT NOT NULL DEFAULT 'gratis';
ALTER TABLE tenants ADD COLUMN limite_anuncios INTEGER NOT NULL DEFAULT 3;
ALTER TABLE tenants ADD COLUMN anuncios_publicados INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN trial_ate TEXT;
ALTER TABLE tenants ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'owner';

-- Novos campos profissionais nos anúncios
ALTER TABLE listings ADD COLUMN tipo_imovel TEXT DEFAULT 'apartamento';
ALTER TABLE listings ADD COLUMN quartos INTEGER;
ALTER TABLE listings ADD COLUMN banheiros INTEGER;
ALTER TABLE listings ADD COLUMN vagas INTEGER;
ALTER TABLE listings ADD COLUMN area_m2 REAL;
ALTER TABLE listings ADD COLUMN status TEXT NOT NULL DEFAULT 'ativo';
ALTER TABLE listings ADD COLUMN destaque INTEGER NOT NULL DEFAULT 0;
ALTER TABLE listings ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE media ADD COLUMN ordem INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN status TEXT NOT NULL DEFAULT 'novo';
ALTER TABLE leads ADD COLUMN observacao TEXT;

-- Planos e cobranças
CREATE TABLE IF NOT EXISTS planos (
  nome TEXT PRIMARY KEY,
  titulo TEXT NOT NULL,
  preco REAL NOT NULL,
  limite_anuncios INTEGER NOT NULL,
  duracao_dias INTEGER NOT NULL,
  selo INTEGER NOT NULL DEFAULT 0,
  destaque INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pagamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plano TEXT NOT NULL,
  valor REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',
  asaas_id TEXT,
  pix_copia_cola TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  pago_em DATETIME
);

INSERT OR IGNORE INTO planos (nome, titulo, preco, limite_anuncios, duracao_dias, selo, destaque) VALUES
  ('gratis', 'Vitrine gratuita', 0, 3, 30, 0, 0),
  ('profissional', 'Profissional', 49.90, 30, 30, 1, 0),
  ('premium', 'Premium', 99.90, 999999, 30, 1, 1);
