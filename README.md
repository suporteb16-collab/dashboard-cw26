# Dashboard — Classical Week 26 (CW26) · Maestro Thiago Santos

Dashboard do lançamento **Classical Week 26** (tag `CW26`), conta de anúncios
**CA - Bebendo o Concerto**. Construído pela **Agência B16**.

- **Produto principal:** combo de todos os produtos, menos a Confraria
- **Captação:** 17/10 → 08/11/2026 · verba R$ 1.500
- **Lembrete:** 05/11 → 14/11/2026 · verba R$ 500
- **Páginas:** [captura](https://escoladoouvido.com/classical-week/) ·
  [obrigado](https://escoladoouvido.com/classical-week-obrigado) ·
  [vendas](https://escoladoouvido.com/classical-week-secreta/)

---

## Arquitetura

```
Planilha do lançamento (Google Sheets, PRIVADA)
   abas: meta_ads · leads · vendas · planejamento · metas_vendas
        │  Sheets API, com service account (só leitura)
        ▼
Cloudflare Worker  (worker.js)
   · escolhe as colunas no servidor — o navegador não pede coluna nenhuma
   · e-mail/telefone saem como HMAC (código), nunca o valor
   · devolve UM JSON com tudo · cache de 2 min no edge
        │
        ▼
index.html  (GitHub Pages, público)
```

A planilha tem nome, e-mail, telefone, CPF e IP de lead e de comprador. Por isso
ela **não pode ser pública**: quem lê é a service account, e só o que o Worker
recorta chega ao navegador.

### O que o Worker entrega

| Aba | Campos |
|---|---|
| `meta_ads` | dia, campanha, conjunto, anúncio, gasto, impressões, cliques no link, checkouts, compras e leads do pixel, thumbnail |
| `leads` | `p_email`/`p_fone` (HMAC), origem, conjunto, campanha, criativo, posicionamento, formulário, data — pelos campos do formulário **e** pela URL da página (`ref_*`) |
| `vendas` | data, pedido, status, método, produto, plano, `p_email`/`p_fone` (HMAC), faturamento, UTMs |
| `planejamento` | fase, tag, meta |
| `metas_vendas` | vendas, faturamento, leads, conversão, investimento RMKT, ROAS, CAC |

---

## Regras de cálculo

**Lead = pessoa, não cadastro.** 36% dos cadastros são a mesma pessoa de novo — a
maioria reenvia o formulário em menos de um minuto. A pessoa é identificada por
e-mail **ou** telefone (union-find: errou o e-mail num envio e acertou no outro,
com o mesmo telefone, continua sendo uma pessoa). Ela conta uma vez, no dia do
primeiro cadastro, com a origem desse cadastro. O KPI *CPL por cadastro* mostra a
conta com repetição, para comparar com a planilha.

**Lead pago = `utm_source` frio ou quente.** WhatsApp (`wpp1`), sem UTM e o resto
são não pagos. Cadastro de teste (`teste` na origem/campanha, `qa_automatizado`)
sai da conta.

**A UTM vem da URL da página, não dos campos do formulário** (`ATRIBUICAO = 'pagina'`
no `index.html`). Os campos ocultos perdem atribuição: o conjunto *00 - Lista de
compradores geral* tem R$ 254 de gasto, aparece em 24 cadastros pelo Referrer e em
**nenhum** pelos campos; o WhatsApp cai de 53 para 14. Cadastro sem UTM na URL usa
os campos. A aba `big_numbers` da planilha conta pelos campos — por isso os números
não batem com ela.

**Investimento = campanhas com `[CW26]` no nome.** A fase sai da tag da campanha
(`[LEADS]`/`[CAPT]` → Captação, `[LEMBRETE]`, `[RMKT]`, `[AQUECIMENTO]`/`[DIST]`,
`[FLASH]`). A meta de cada fase vem da aba `planejamento`; as datas, do briefing.

**Ritmo da fase** = gasto ÷ (meta × dias decorridos ÷ dias da fase). A projeção usa
a média dos últimos 7 dias **fechados** — o dia de hoje ainda está incompleto na Meta.

**Venda do CW26** = pedido a partir de 13/10/2026 com `Classical Week 2026`/`CW26`
no produto **ou no plano**, ou `utm_campaign` do lançamento (`cw26`/`cw1126`). O
plano importa: em 2025 o CW foi vendido como plano *Classical Week 2025* do produto
Confraria. A aba `vendas` é o log de webhook do Maestro inteiro — um pedido aparece
uma vez por evento, e o dashboard consolida por pedido (estorno ganha de pago, pago
ganha do resto). Faturamento = coluna `Faturamento` (líquido do produtor), o
contrato de receita da B16. **Conferir o nome do produto quando o carrinho abrir**
(constante `VENDA_CW`).

**Metas de venda** só aparecem quando a aba `metas_vendas` sair do marcador `1/1/1`.

---

## Achados na planilha (26/10/2026)

1. 🔴 **Captação acima do ritmo.** R$ 1.164 de R$ 1.500 usados no dia 10 de 23
   (179% do ritmo). Na média dos últimos 7 dias (R$ 121/dia) a verba acaba em
   **28/10**, onze dias antes do fim da fase. Para fechar na meta: R$ 25,81/dia.
2. 🟡 **Aba `leads` parada em 23/10 10:29**, mídia até 26/10. O CPL do período
   inclui três dias de gasto sem lead. Até 22/10 (último dia completo) o CPL era
   R$ 8,65.
3. 🟡 **Cabeçalho da aba `leads` desalinhado nas colunas C–I**: a coluna chamada
   `utm_source` tem o e-mail, `utm_medium` tem o utm_source, e assim por diante. O
   Worker lê por letra; se o fluxo for corrigido, ele detecta e passa a ler pelo nome.
4. 🟡 **Campos ocultos do formulário perdem UTM** (ver *Regras*). Vale revisar o
   script que preenche os campos na página de captura.
5. 🟡 **Macro da Meta sem interpolar** em cadastros (`{{adset.name}}`,
   `{{placement}}`). Corrigir o parâmetro de URL do anúncio.
6. ℹ️ `utm_campaign` dos leads chega como `cw1126`, não `cw26`.

---

## Arquivos

| | |
|---|---|
| `index.html` | o dashboard (HTML/CSS/JS puro, Chart.js 4, sem build) |
| `worker.js` | o Cloudflare Worker — sem segredo no código; tudo vai nos Secrets |

Para testar sem o Worker: servir a pasta em `localhost` e abrir
`http://localhost:8000/?fonte=arquivo.json` com um JSON no formato do Worker. O
parâmetro `fonte` só funciona em localhost.

Visual: paleta clássica B16 (`#f4f4f2` / `#d4a800` / `#111`, Bebas Neue + DM Sans),
tema claro e escuro, mesmos padrões do dashboard AAEMCWEB (funil em trapézio,
rótulo direto em toda barra, 2 slots categóricos).

---

## Deploy

### 1. Service account (Google Cloud)
1. [console.cloud.google.com](https://console.cloud.google.com) → escolher o projeto.
2. **APIs e serviços → Biblioteca → Google Sheets API → Ativar.**
3. **IAM e administrador → Contas de serviço → Criar conta de serviço** (nenhum papel
   é necessário).
4. Na conta criada: **Chaves → Adicionar chave → Criar nova chave → JSON**. Guardar o
   arquivo.
5. Copiar o `client_email` do JSON e **compartilhar a planilha com ele como Leitor**.

### 2. Cloudflare Worker
1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → Create →
   Start with Hello World** → nome `cw26-dados` → **Deploy**.
2. **Edit code** → apagar tudo → colar o `worker.js` → **Deploy**.
3. **Settings → Variables and Secrets → Add**, tipo **Secret**:
   `SHEET_ID`, `GOOGLE_SA_KEY` (o JSON inteiro), `PII_SALT` (texto aleatório longo).
4. Abrir `https://cw26-dados.<subdominio>.workers.dev/` → tem que aparecer um JSON
   com `"abas"`.

### 3. GitHub Pages
1. Trocar `WORKER_URL` no `index.html` pela URL do Worker.
2. Repositório novo, público → subir `index.html`, `README.md` e `worker.js`.
3. **Settings → Pages → Deploy from a branch → `main` / `(root)` → Save.**

---

**Agência B16** — Henrique Cardoso, Business Intelligence · 26/10/2026.
