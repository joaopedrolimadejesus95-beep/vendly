import pg from "pg";

const { Pool } = pg;

// Uma "pool" (piscina) de conexões — o Postgres real, não mais arquivos JSON.
// Isso resolve de vez o problema de concorrência (dois pedidos ao mesmo
// tempo) porque o próprio banco de dados garante que operações não se
// atropelem — não precisamos mais da fila manual (fileLock.js).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Cria as tabelas na primeira vez que o servidor rodar, se ainda não
// existirem. Isso permite "clonar" o projeto num servidor novo e ele já
// se organizar sozinho, sem precisar rodar comando de migração manual.
export async function inicializarBancoDeDados() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empresa (
      id INTEGER PRIMARY KEY DEFAULT 1,
      nome TEXT DEFAULT '',
      tipo TEXT DEFAULT 'restaurante',
      aceita_entrega BOOLEAN DEFAULT true,
      endereco TEXT DEFAULT '',
      formas_pagamento JSONB DEFAULT '["pix","dinheiro","cartão"]',
      exige_pagamento_antecipado BOOLEAN DEFAULT false,
      dias_funcionamento JSONB DEFAULT '[]',
      horario_abertura TEXT DEFAULT '',
      horario_fechamento TEXT DEFAULT '',
      auth_salt TEXT,
      auth_hash TEXT,
      CONSTRAINT unica_linha CHECK (id = 1)
    );

    -- Garante que sempre existe exatamente 1 linha de configuração da empresa.
    INSERT INTO empresa (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS produtos (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      preco NUMERIC(10,2) NOT NULL,
      descricao TEXT DEFAULT '',
      disponivel BOOLEAN DEFAULT true,
      tem_meia_porcao BOOLEAN DEFAULT false,
      preco_meia NUMERIC(10,2),
      adicionais JSONB DEFAULT '[]',
      estoque INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      numero_cliente TEXT NOT NULL,
      itens JSONB NOT NULL,
      total NUMERIC(10,2) NOT NULL,
      tipo_entrega TEXT,
      endereco TEXT,
      impresso BOOLEAN DEFAULT false,
      data_hora TIMESTAMPTZ DEFAULT now()
    );
  `);
}
