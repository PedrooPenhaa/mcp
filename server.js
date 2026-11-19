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