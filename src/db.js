import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Schema multi-empresa: cada restaurante cliente é uma linha na tabela
// "empresas", com login e senha próprios. Produtos e pedidos "pertencem"
// a uma empresa específica (empresa_id), garantindo que os dados de um
// restaurante nunca aparecem pra outro.
export async function inicializarBancoDeDados() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empresas (
      id SERIAL PRIMARY KEY,
      nome TEXT DEFAULT '',
      tipo TEXT DEFAULT 'restaurante',
      aceita_entrega BOOLEAN DEFAULT true,
      endereco TEXT DEFAULT '',
      formas_pagamento JSONB DEFAULT '["pix","dinheiro","cartão"]',
      exige_pagamento_antecipado BOOLEAN DEFAULT false,
      dias_funcionamento JSONB DEFAULT '[]',
      horario_abertura TEXT DEFAULT '',
      horario_fechamento TEXT DEFAULT '',
      login TEXT UNIQUE NOT NULL,
      senha_salt TEXT NOT NULL,
      senha_hash TEXT NOT NULL,
      evolution_instance TEXT UNIQUE NOT NULL,
      plano TEXT DEFAULT 'base',
      separar_bebida_comanda BOOLEAN DEFAULT false,
      impressoras JSONB DEFAULT '{}',
      criado_em TIMESTAMPTZ DEFAULT now()
    );

    -- Garante o campo em bancos que já tinham "empresas" de antes do
    -- sistema de planos existir.
    ALTER TABLE empresas ADD COLUMN IF NOT EXISTS plano TEXT DEFAULT 'base';
    ALTER TABLE empresas ADD COLUMN IF NOT EXISTS separar_bebida_comanda BOOLEAN DEFAULT false;
    ALTER TABLE empresas ADD COLUMN IF NOT EXISTS impressoras JSONB DEFAULT '{}';
    -- Taxa de serviço (%) aplicada ao fechar mesa. 0 = desligada.
    ALTER TABLE empresas ADD COLUMN IF NOT EXISTS taxa_servico_percent NUMERIC(5,2) DEFAULT 0;

    CREATE TABLE IF NOT EXISTS produtos (
      id TEXT NOT NULL,
      empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      nome TEXT NOT NULL,
      preco NUMERIC(10,2) NOT NULL,
      descricao TEXT DEFAULT '',
      disponivel BOOLEAN DEFAULT true,
      tem_meia_porcao BOOLEAN DEFAULT false,
      preco_meia NUMERIC(10,2),
      adicionais JSONB DEFAULT '[]',
      estoque INTEGER DEFAULT 0,
      unidade TEXT DEFAULT '',
      categoria TEXT DEFAULT 'comida',
      PRIMARY KEY (empresa_id, id)
    );

    -- Garante o campo em bancos que já tinham "produtos" de antes da
    -- unidade existir.
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS unidade TEXT DEFAULT '';
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS categoria TEXT DEFAULT 'comida';
    -- Tamanhos com nome e preço livres (ex: pizza "PP/P/M/G", bebida
    -- "lata/garrafa") — mecanismo NOVO e adicional, separado do preço
    -- único e da meia porção acima. Produto com tamanhos[] vazio (padrão)
    -- continua funcionando exatamente como antes, com preco/preco_meia.
    -- Quando tamanhos[] tem itens, ELE manda no preço — preco/preco_meia
    -- deixam de ser usados pra aquele produto.
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS tamanhos JSONB DEFAULT '[]';

    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      numero_cliente TEXT NOT NULL,
      itens JSONB NOT NULL,
      total NUMERIC(10,2) NOT NULL,
      tipo_entrega TEXT,
      endereco TEXT,
      impresso BOOLEAN DEFAULT false,
      data_hora TIMESTAMPTZ DEFAULT now(),
      origem TEXT DEFAULT 'whatsapp',
      mesa_numero TEXT,
      atendente_nome TEXT
    );

    -- Adiciona as colunas novas em bancos que já tinham a tabela "pedidos"
    -- de antes do módulo de Mesas existir (sem apagar nenhum pedido).
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS origem TEXT DEFAULT 'whatsapp';
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS mesa_numero TEXT;
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS atendente_nome TEXT;
    -- Detalhamento financeiro do fechamento (mesa). "total" continua sendo
    -- o valor final cobrado; estes explicam como chegou nele.
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS subtotal NUMERIC(10,2);
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS taxa_servico NUMERIC(10,2) DEFAULT 0;
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS desconto NUMERIC(10,2) DEFAULT 0;
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS desconto_motivo TEXT;
    -- Pedido cancelado NUNCA é apagado (fica no histórico/relatórios como
    -- cancelado) — diferente de "reabrir mesa", que é pra corrigir um
    -- fechamento por engano. "impresso" volta pra false pra a comanda de
    -- cancelamento entrar na fila de impressão de novo, avisando a cozinha.
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancelado BOOLEAN DEFAULT false;
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancelado_em TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_pedidos_empresa ON pedidos(empresa_id);
    CREATE INDEX IF NOT EXISTS idx_produtos_empresa ON produtos(empresa_id);

    -- Mesas do restaurante. Cada mesa guarda o "carrinho" da comanda em
    -- andamento (itens_atuais) direto nela — quando o atendente fecha a
    -- mesa, esse carrinho vira um pedido de verdade na tabela "pedidos"
    -- (mesma tabela do WhatsApp) e a mesa volta a ficar livre.
    CREATE TABLE IF NOT EXISTS mesas (
      id SERIAL PRIMARY KEY,
      empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      numero TEXT NOT NULL,
      status TEXT DEFAULT 'livre',
      itens_atuais JSONB DEFAULT '[]',
      aberta_em TIMESTAMPTZ,
      UNIQUE(empresa_id, numero)
    );

    CREATE INDEX IF NOT EXISTS idx_mesas_empresa ON mesas(empresa_id);

    -- Contas de atendente (garçom, caixa, etc) — login separado do dono,
    -- com acesso restrito só à aba de Mesas. Só faz sentido pra quem tem
    -- o módulo de Mesas no plano.
    CREATE TABLE IF NOT EXISTS atendentes (
      id SERIAL PRIMARY KEY,
      empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      nome TEXT NOT NULL,
      login TEXT UNIQUE NOT NULL,
      senha_salt TEXT NOT NULL,
      senha_hash TEXT NOT NULL,
      criado_em TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_atendentes_empresa ON atendentes(empresa_id);

    -- "Lançamentos" de mesa — quando o atendente clica em "Lançar pedido"
    -- (manda os itens novos pra cozinha SEM fechar a mesa/conta). Isso é
    -- diferente de um "pedido" de verdade: não é uma venda fechada, é só
    -- um aviso pra cozinha começar a preparar. A venda de verdade só é
    -- criada quando a mesa FECHA (tabela "pedidos").
    CREATE TABLE IF NOT EXISTS lancamentos_mesa (
      id SERIAL PRIMARY KEY,
      empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      mesa_numero TEXT NOT NULL,
      itens JSONB NOT NULL,
      atendente_nome TEXT,
      impresso BOOLEAN DEFAULT false,
      criado_em TIMESTAMPTZ DEFAULT now()
    );

    -- "cancelamento = true" identifica um lançamento que NÃO é comida nova
    -- pra cozinha preparar, e sim um aviso pra TIRAR da produção algo que
    -- já tinha sido lançado (item removido da mesa depois de já ter ido
    -- pra cozinha). O agente de impressão local deve imprimir esses de
    -- forma bem diferente (ex: "CANCELAR — NÃO PREPARAR").
    ALTER TABLE lancamentos_mesa ADD COLUMN IF NOT EXISTS cancelamento BOOLEAN DEFAULT false;

    CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa ON lancamentos_mesa(empresa_id);
  `);
}
