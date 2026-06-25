'use strict';
// 大模型接入（OpenAI 兼容）。配置存在外部数据目录 llm_config.json，升级不丢、不写死在代码里。
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MIXER_DATA_DIR || path.join(path.dirname(__dirname), path.basename(__dirname) + '-data');
const CFG_PATH = path.join(DATA_DIR, 'llm_config.json');

function loadCfg() {
  let c = {};
  try { if (fs.existsSync(CFG_PATH)) c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8').replace(/^﻿/, '')); } catch (_) {}
  return {
    base: process.env.LLM_BASE_URL || c.base_url || '',
    key: process.env.LLM_API_KEY || c.api_key || '',
    model: process.env.LLM_MODEL || c.model || 'qwen-plus',
  };
}

function configured() { const c = loadCfg(); return !!(c.base && c.key); }
function modelName() { return loadCfg().model; }

async function chat(messages, opts = {}) {
  const c = loadCfg();
  if (!c.base || !c.key) throw new Error('未配置大模型（llm_config.json）');
  const url = c.base.replace(/\/$/, '') + '/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + c.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model || c.model,
      messages,
      temperature: opts.temperature ?? 0.8,
      max_tokens: opts.max_tokens ?? 1500,
    }),
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { throw new Error('模型返回异常: ' + t.slice(0, 200)); }
  if (!r.ok) throw new Error('模型错误 ' + r.status + ': ' + (j.error?.message || t.slice(0, 200)));
  const out = j.choices?.[0]?.message?.content;
  if (!out) throw new Error('模型无输出');
  return out.trim();
}

module.exports = { configured, chat, modelName };
