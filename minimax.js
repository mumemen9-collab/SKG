'use strict';
// MiniMax 文本转语音（T2A v2）。配置在 D:\Dvideo-tool-data\minimax_config.json。
// 接口：POST {base_url}/v1/t2a_v2  Header: Authorization: Bearer <key>
// 返回 data.audio 为 hex 编码音频；本模块解码成 Buffer。
const fs = require('fs');
const path = require('path');

const CONFIG = process.env.MINIMAX_CONFIG || path.join(process.env.MIXER_DATA_DIR || 'D:\\Dvideo-tool-data', 'minimax_config.json');

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^﻿/, ''));
  if (!cfg.api_key) throw new Error('minimax_config.json 缺少 api_key');
  return {
    apiKey: cfg.api_key,
    groupId: cfg.group_id || '',
    baseUrl: (cfg.base_url || 'https://api.minimax.chat').replace(/\/$/, ''),
    model: cfg.model || 'speech-02-hd',
    voiceId: cfg.voice_id || 'English_expressive_narrator',
    speed: Number(cfg.speed) || 1.0,
    vol: Number(cfg.vol) || 1.0,
    pitch: Number(cfg.pitch) || 0,
    format: cfg.format || 'mp3',
    sampleRate: Number(cfg.sample_rate) || 32000,
    bitrate: Number(cfg.bitrate) || 128000,
    languageBoost: cfg.language_boost || 'auto',
  };
}
function configured() { try { loadConfig(); return true; } catch (_) { return false; } }

// 可选语音（精选；用户也可在配置里填任意 voice_id）
const VOICES = [
  { id: 'English_expressive_narrator', label: '英文 · 表现力旁白（默认）' },
  { id: 'English_Trustworth_Man', label: '英文 · 沉稳男声' },
  { id: 'English_Graceful_Lady', label: '英文 · 优雅女声' },
  { id: 'English_CalmWoman', label: '英文 · 平静女声' },
  { id: 'male-qn-qingse', label: '中文 · 青涩男声' },
  { id: 'female-shaonv', label: '中文 · 少女声' },
  { id: 'presenter_female', label: '中文 · 女主持' },
];

async function tts(text, opts = {}) {
  const c = loadConfig();
  const t = String(text || '').trim();
  if (!t) throw new Error('文本为空');
  const url = c.baseUrl + '/v1/t2a_v2' + (c.groupId ? '?GroupId=' + encodeURIComponent(c.groupId) : '');
  const voice_setting = {
    voice_id: opts.voiceId || c.voiceId,
    speed: opts.speed != null ? Number(opts.speed) : c.speed,
    vol: opts.vol != null ? Number(opts.vol) : c.vol,
    pitch: opts.pitch != null ? Number(opts.pitch) : c.pitch,
  };
  if (opts.emotion) voice_setting.emotion = opts.emotion; // happy/sad/angry/... 仅 speech-02 系列支持
  const body = {
    model: opts.model || c.model,
    text: t,
    stream: false,
    voice_setting,
    audio_setting: { sample_rate: c.sampleRate, bitrate: c.bitrate, format: c.format },
    language_boost: opts.languageBoost || c.languageBoost,
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let j;
  try { j = await r.json(); } catch (e) { throw new Error('MiniMax 返回非 JSON（HTTP ' + r.status + '）'); }
  const base = j.base_resp || {};
  if (base.status_code !== 0) throw new Error(`MiniMax 错误 ${base.status_code}: ${base.status_msg || '未知'}`);
  if (!j.data || !j.data.audio) throw new Error('MiniMax 未返回音频');
  const buf = Buffer.from(j.data.audio, 'hex');
  const durMs = (j.extra_info && j.extra_info.audio_length) || 0;
  return { buffer: buf, durationMs: durMs, format: c.format, bytes: buf.length };
}

// 拉取账户全部系统音色（缓存 10 分钟）
let _voiceCache = null, _voiceCacheAt = 0;
async function listVoices() {
  if (_voiceCache && Date.now() - _voiceCacheAt < 600000) return _voiceCache;
  const c = loadConfig();
  const url = c.baseUrl + '/v1/get_voice' + (c.groupId ? '?GroupId=' + encodeURIComponent(c.groupId) : '');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice_type: 'system' }),
  });
  const j = await r.json();
  if ((j.base_resp || {}).status_code !== 0) throw new Error('get_voice 失败: ' + ((j.base_resp || {}).status_msg || '未知'));
  const list = (j.system_voice || []).map((v) => ({ id: v.voice_id, name: v.voice_name || v.voice_id })).filter((v) => v.id);
  _voiceCache = list; _voiceCacheAt = Date.now();
  return list;
}

// 可选模型 / 情绪 / 语言（供前端配音工坊下拉）
const MODELS = [
  { id: 'speech-02-hd', label: 'speech-02-hd · 高清(推荐)' },
  { id: 'speech-02-turbo', label: 'speech-02-turbo · 快速' },
  { id: 'speech-01-hd', label: 'speech-01-hd · 高清(旧版)' },
  { id: 'speech-01-turbo', label: 'speech-01-turbo · 快速(旧版)' },
];
const EMOTIONS = [
  { id: '', label: '自动 / 不指定' },
  { id: 'happy', label: '开心' }, { id: 'sad', label: '悲伤' }, { id: 'angry', label: '愤怒' },
  { id: 'fearful', label: '恐惧' }, { id: 'disgusted', label: '厌恶' }, { id: 'surprised', label: '惊讶' }, { id: 'neutral', label: '中性' },
];
const LANGS = [
  { id: 'auto', label: '自动' }, { id: 'English', label: '英文' }, { id: 'Chinese', label: '中文' },
  { id: 'Chinese,Yue', label: '粤语' }, { id: 'Spanish', label: '西班牙语' }, { id: 'Portuguese', label: '葡萄牙语' },
  { id: 'Japanese', label: '日语' }, { id: 'Korean', label: '韩语' }, { id: 'French', label: '法语' }, { id: 'German', label: '德语' },
];

module.exports = { configured, tts, VOICES, MODELS, EMOTIONS, LANGS, loadConfig, listVoices };
