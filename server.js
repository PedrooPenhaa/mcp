import express from "express";
import mysql from "mysql2/promise";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------- Config (variáveis de ambiente) ----------
const {
  DB_HOST,
  DB_PORT = "3306",
  DB_USER,
  DB_PASSWORD,
  DB_NAME = "dicocdb",
  DB_CA,            // opcional: conteúdo do CA certificate do Aiven
  API_KEY,          // chave que o Copilot Studio vai mandar no header x-api-key
  MAX_ROWS = "200",
  PORT = "3000",
} = process.env;

const maxRows = Number(MAX_ROWS);

const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  connectionLimit: 5,
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  ssl: DB_CA
    ? { ca: DB_CA.replace(/\\n/g, "\n"), rejectUnauthorized: true }
    : { rejectUnauthorized: false },
});

// ---------- Helpers ----------
const json = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

const erro = (msg) => ({
  isError: true,
  content: [{ type: "text", text: `Erro: ${msg}` }],
});

function validarSelect(sql) {
  const limpo = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(limpo)) {
    throw new Error("Só são permitidas consultas SELECT (ou WITH ... SELECT).");
  }
  if (limpo.includes(";")) {
    throw new Error("Envie apenas uma consulta por vez.");
  }
  if (/\b(into\s+(out|dump)file|for\s+update|lock\s+in\s+share\s+mode|sleep\s*\(|benchmark\s*\()/i.test(limpo)) {
    throw new Error("Consulta contém construção não permitida.");
  }
  return limpo;
}

async function consultaSomenteLeitura(sql, params = []) {
  const conn = await pool.getConnection();
  try {
    await conn.query("START TRANSACTION READ ONLY");
    const [rows] = await conn.query({ sql, values: params, timeout: 15000 });
    await conn.query("ROLLBACK");
    return rows;
  } catch (e) {
    try { await conn.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    conn.release();
  }
}

// ---------- Servidor MCP ----------
function criarServidor() {
  const server = new McpServer({ name: "dicocdb-mcp", version: "1.0.0" });

  server.registerTool(
    "listar_tabelas",
    {
      title: "Listar tabelas",
      description:
        "Lista todas as tabelas e views do banco dicocdb. Use primeiro para descobrir onde estão os dados.",
      inputSchema: {},
    },
    async () => {
      try {
        const rows = await consultaSomenteLeitura(
          `SELECT TABLE_NAME AS nome, TABLE_TYPE AS tipo, TABLE_ROWS AS linhas_aprox
             FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE()
            ORDER BY TABLE_NAME`
        );
        return json(rows);
      } catch (e) {
        return erro(e.message);
      }
    }
  );

  server.registerTool(
    "descrever_tabela",
    {
      title: "Descrever tabela",
      description:
        "Mostra as colunas (nome, tipo, chave, comentário) de uma tabela ou view. Use antes de montar uma consulta.",
      inputSchema: { tabela: z.string().describe("Nome exato da tabela ou view") },
    },
    async ({ tabela }) => {
      try {
        const rows = await consultaSomenteLeitura(
          `SELECT COLUMN_NAME AS coluna, COLUMN_TYPE AS tipo, IS_NULLABLE AS aceita_nulo,
                  COLUMN_KEY AS chave, COLUMN_COMMENT AS comentario
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
              AND EXTRA NOT LIKE '%INVISIBLE%'
            ORDER BY ORDINAL_POSITION`,
          [tabela]
        );
        if (!rows.length) return erro(`Tabela '${tabela}' não encontrada.`);
        return json(rows);
      } catch (e) {
        return erro(e.message);
      }
    }
  );

  server.registerTool(
    "consultar_sql",
    {
      title: "Consultar SQL",
      description:
        `Executa UMA consulta SELECT (MySQL 8) somente leitura no banco dicocdb e devolve as linhas em JSON. ` +
        `Retorna no máximo ${maxRows} linhas; use WHERE, LIMIT e agregações (COUNT, SUM) para respostas precisas. ` +
        `Para buscar texto use LIKE '%termo%'.`,
      inputSchema: { sql: z.string().describe("Consulta SELECT em MySQL") },
    },
    async ({ sql }) => {
      try {
        const seguro = validarSelect(sql);
        const rows = await consultaSomenteLeitura(seguro);
        const truncado = rows.length > maxRows;
        return json({
          total_retornado: Math.min(rows.length, maxRows),
          truncado,
          linhas: rows.slice(0, maxRows),
        });
      } catch (e) {
        return erro(e.message);
      }
    }
  );

  return server;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.send("ok")); // health check / keep-alive

app.use("/mcp", (req, res, next) => {
  if (API_KEY && req.get("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// Modo stateless: um servidor/transport por requisição
app.post("/mcp", async (req, res) => {
  try {
    const server = criarServidor();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const metodoNaoPermitido = (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
app.get("/mcp", metodoNaoPermitido);
app.delete("/mcp", metodoNaoPermitido);

app.listen(Number(PORT), () => console.log(`MCP rodando na porta ${PORT} em /mcp`));
