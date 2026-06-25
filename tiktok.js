'use strict';
// TikTok Marketing API 接入：复用 D:\tkads_export\config.json 的凭证，
// 按「投放的视频(video_id)」聚合广告级报表 → 花费/曝光/点击/转化/GMV/ROAS。
// Token 只在服务端使用，绝不返回给浏览器。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TT_CONFIG = process.env.TT_CONFIG || 'D:\\tkads_export\\config.json';
const TT_ALL_IDS = process.env.TT_ALL_IDS || 'D:\\tkads_export\\advertiser_ids_all.json';
const BASE = 'https://business-api.tiktok.com/open_api/v1.3';

// 广告级报表要拉的 metric（含营收类，用于 GMV/ROAS）
const METRICS = ['spend', 'impressions', 'clicks', 'conversion', 'onsite_shopping', 'total_onsite_shopping_value', 'complete_payment', 'video_watched_2s'];
const AD_FIELDS = ['ad_id', 'ad_name', 'video_id', 'adgroup_id', 'campaign_id', 'operation_status'];

// 只保留「转化类」投放（TikTok Shop 出单 / 网站转化等）；品牌曝光、考虑、播放量、触达等一律排除。
const CONVERSION_OBJECTIVES = new Set(['PRODUCT_SALES', 'WEB_CONVERSIONS', 'CONVERSIONS', 'CONVERSION', 'CATALOG_SALES', 'SHOP_PURCHASES']);
function isConversionObjective(obj) {
  if (!obj) return true; // 取不到目标的不丢弃，避免漏数据
  const o = String(obj).toUpperCase();
  if (CONVERSION_OBJECTIVES.has(o)) return true;
  return /CONVERSION|SALES|PURCHASE|SHOP/.test(o); // 兜底：名字里含转化/出单语义的也算
}

// 默认拉取最近 N 天（截止今天），避免只看到配置里写死的旧区间而漏掉最新视频
function recentRange(days = 30) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { start: fmt(new Date(Date.now() - days * 86400000)), end: fmt(new Date()) };
}

function loadConfig() {
  if (!fs.existsSync(TT_CONFIG)) throw new Error('未找到 TikTok 配置文件：' + TT_CONFIG);
  const cfg = JSON.parse(fs.readFileSync(TT_CONFIG, 'utf8').replace(/^﻿/, ''));
  const token = cfg.access_token;
  const advIds = (cfg.advertiser_ids || []).map(String);
  if (!token) throw new Error('config.json 缺少 access_token');
  if (!advIds.length) throw new Error('config.json 缺少 advertiser_ids');
  return { token, advIds, start: cfg.start_date, end: cfg.end_date };
}

function configured() {
  try { loadConfig(); return true; } catch (_) { return false; }
}

function encodeParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    out[k] = Array.isArray(v) || typeof v === 'object' ? JSON.stringify(v) : v;
  }
  return new URLSearchParams(out).toString();
}

async function apiGet(path, token, params, maxRetries = 4) {
  const url = `${BASE}${path}?${encodeParams(params)}`;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let payload;
    try {
      const r = await fetch(url, { headers: { 'Access-Token': token, 'Content-Type': 'application/json' } });
      payload = await r.json();
    } catch (e) {
      if (attempt < maxRetries) { await sleep(1000 * 2 ** attempt); continue; }
      throw e;
    }
    if (payload.code === 0) return payload;
    if (payload.code === 50002 && attempt < maxRetries) { await sleep(1000 * 2 ** attempt); continue; }
    throw new Error(`TikTok API 错误 code=${payload.code} message=${payload.message}`);
  }
  throw new Error('超过最大重试次数：' + path);
}

async function apiGetPaged(path, token, params, pageSize = 1000) {
  const results = [];
  let page = 1;
  while (true) {
    const payload = await apiGet(path, token, { ...params, page, page_size: pageSize });
    const data = payload.data || {};
    results.push(...(data.list || []));
    const totalPage = (data.page_info || {}).total_page || 1;
    if (page >= totalPage || !(data.list || []).length) break;
    page++;
    await sleep(250);
  }
  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

// 广告主信息 + 余额
async function getAdvertisers() {
  const { token, advIds, start, end } = loadConfig();
  const payload = await apiGet('/advertiser/info/', token, {
    advertiser_ids: advIds,
    fields: ['advertiser_id', 'name', 'currency', 'balance', 'status'],
  });
  return {
    advertisers: (payload.data?.list || []).map((a) => ({
      id: a.advertiser_id, name: a.name, currency: a.currency, balance: num(a.balance), status: a.status,
    })),
    // 默认区间改为「最近30天到今天」，确保能看到最新投放的视频（旧逻辑用的是配置里写死的过期日期）
    defaultStart: recentRange(30).start,
    defaultEnd: recentRange(30).end,
  };
}

// 全部广告户 ID（优先读 advertiser_ids_all.json，否则用 config 里的）
function allAdvertiserIds() {
  try {
    const j = JSON.parse(fs.readFileSync(TT_ALL_IDS, 'utf8').replace(/^﻿/, ''));
    if (Array.isArray(j.advertiser_ids) && j.advertiser_ids.length) return j.advertiser_ids.map(String);
  } catch (_) {}
  return loadConfig().advIds;
}

// 列出所有广告户（id + 名称），供上传时选择
async function listAccounts() {
  const { token } = loadConfig();
  const ids = allAdvertiserIds();
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const p = await apiGet('/advertiser/info/', token, { advertiser_ids: batch, fields: ['advertiser_id', 'name', 'status'] });
      for (const a of (p.data?.list || [])) out.push({ id: String(a.advertiser_id), name: a.name || a.advertiser_id, status: a.status });
    } catch (_) { for (const id of batch) out.push({ id, name: id }); }
  }
  const have = new Set(out.map((x) => x.id));
  for (const id of ids) if (!have.has(id)) out.push({ id, name: id });
  return out;
}

// 上传一份已读入的视频 buffer 到某广告户（multipart/form-data，UPLOAD_BY_FILE）
// 52201/50002 等是 TikTok 的瞬时/限流错误，自动退避重试
async function uploadVideoBuf(advertiserId, buf, fname, sig) {
  const { token } = loadConfig();
  const maxRetries = 4;
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let j;
    try {
      const fd = new FormData();
      fd.append('advertiser_id', String(advertiserId));
      fd.append('upload_type', 'UPLOAD_BY_FILE');
      fd.append('video_signature', sig);
      fd.append('file_name', fname);
      fd.append('video_file', new Blob([buf]), fname);
      const r = await fetch(BASE + '/file/video/ad/upload/', { method: 'POST', headers: { 'Access-Token': token }, body: fd });
      j = await r.json().catch(() => ({}));
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) { await sleep(1500 * attempt); continue; }
      throw e;
    }
    if (j.code === 0) {
      const item = Array.isArray(j.data) ? j.data[0] : j.data;
      return { video_id: item?.video_id, material_id: item?.material_id, name: item?.file_name || fname };
    }
    lastErr = new Error(`code=${j.code} ${j.message || ''}`);
    // 52201 上传失败 / 50002 限流 / 5xxxx 服务端错误 → 退避重试；鉴权/参数错误（4xxxx）不重试
    const retriable = j.code === 52201 || j.code === 50002 || (j.code >= 50000 && j.code < 60000);
    if (retriable && attempt < maxRetries) { await sleep(2000 * attempt); continue; }
    throw lastErr;
  }
  throw lastErr;
}

// 上传到单个广告户（fileName 指定 TikTok 素材名，缺省用文件名）
async function uploadVideo(advertiserId, filePath, fileName) {
  const buf = fs.readFileSync(filePath);
  const sig = crypto.createHash('md5').update(buf).digest('hex');
  return uploadVideoBuf(advertiserId, buf, fileName || path.basename(filePath), sig);
}

// 一次上传到多个广告户（文件只读一次）。返回每个账户的结果
async function uploadVideoMulti(advertiserIds, filePath, fileName) {
  const buf = fs.readFileSync(filePath);
  const sig = crypto.createHash('md5').update(buf).digest('hex');
  const fname = fileName || path.basename(filePath);
  const results = [];
  for (let i = 0; i < advertiserIds.length; i++) {
    const id = advertiserIds[i];
    try { const r = await uploadVideoBuf(id, buf, fname, sig); results.push({ advertiserId: String(id), ok: true, ...r }); }
    catch (e) { results.push({ advertiserId: String(id), ok: false, error: String(e.message || e) }); }
    if (i < advertiserIds.length - 1) await sleep(700); // 账户间隔，避免限流
  }
  return results;
}

// 按视频聚合的投放报表
async function getVideoReport(start, end) {
  const { token, advIds } = loadConfig();
  const rr = recentRange(30);
  start = start || rr.start; // 缺省=最近30天，保证拉到最新视频
  end = end || rr.end;

  // 0) 先拉广告系列，建 campaign_id -> objective_type（用于排除品牌/播放量类）
  const campObj = new Map();
  for (const adv of advIds) {
    try {
      const camps = await apiGetPaged('/campaign/get/', token, { advertiser_id: adv, fields: ['campaign_id', 'objective_type'] });
      for (const c of camps) campObj.set(String(c.campaign_id), c.objective_type || '');
    } catch (_) {}
  }

  // 1) 拉所有广告，建 ad_id -> {video_id, ad_name, objective, ...} 映射
  const adMap = new Map();
  for (const adv of advIds) {
    const ads = await apiGetPaged('/ad/get/', token, { advertiser_id: adv, fields: AD_FIELDS });
    for (const ad of ads) {
      adMap.set(String(ad.ad_id), {
        video_id: ad.video_id || '', ad_name: ad.ad_name || '', adgroup_id: ad.adgroup_id,
        campaign_id: ad.campaign_id, advertiser_id: adv, status: ad.operation_status,
        objective: campObj.get(String(ad.campaign_id)) || '',
      });
    }
  }

  // 2) 拉广告级报表，按 video_id 聚合（排除品牌/播放量类投放）
  const perVideo = new Map();
  const excludedKeys = new Set();
  let totSpend = 0, totGmv = 0;
  for (const adv of advIds) {
    const rows = await apiGetPaged('/report/integrated/get/', token, {
      advertiser_id: adv, report_type: 'BASIC', data_level: 'AUCTION_AD',
      dimensions: ['ad_id', 'stat_time_day'], metrics: METRICS, start_date: start, end_date: end,
    });
    for (const r of rows) {
      const adId = String(r.dimensions?.ad_id || '');
      const m = r.metrics || {};
      const meta = adMap.get(adId) || {};
      // 只保留转化类投放；品牌/考虑/播放量等排除
      if (!isConversionObjective(meta.objective)) { excludedKeys.add(meta.video_id || adId); continue; }
      const key = meta.video_id || ('ad:' + adId); // 无 video_id 的按广告单列
      if (!perVideo.has(key)) {
        perVideo.set(key, {
          video_id: meta.video_id || '', name: meta.ad_name || adId, ads: new Set(),
          spend: 0, impressions: 0, clicks: 0, conversion: 0, gmv: 0, purchases: 0, payments: 0, view2s: 0,
          objective: meta.objective || '', advertiser_id: adv,
        });
      }
      const v = perVideo.get(key);
      v.ads.add(adId);
      if (meta.ad_name && (!v.name || v.name === adId)) v.name = meta.ad_name;
      v.spend += num(m.spend);
      v.impressions += num(m.impressions);
      v.clicks += num(m.clicks);
      v.conversion += num(m.conversion);
      v.gmv += num(m.total_onsite_shopping_value);
      v.purchases += num(m.onsite_shopping);
      v.payments += num(m.complete_payment);
      v.view2s += num(m.video_watched_2s);
      totSpend += num(m.spend);
      totGmv += num(m.total_onsite_shopping_value);
    }
  }

  // 3) 计算衍生指标，排序
  const list = [...perVideo.values()].map((v) => ({
    video_id: v.video_id,
    name: v.name,
    ad_count: v.ads.size,
    spend: round(v.spend),
    impressions: Math.round(v.impressions),
    clicks: Math.round(v.clicks),
    ctr: v.impressions ? round((v.clicks / v.impressions) * 100, 2) : 0,
    view2s: Math.round(v.view2s),
    view2s_rate: v.impressions ? round((v.view2s / v.impressions) * 100, 2) : 0, // 2秒完播率 = 2秒播放数/曝光
    cpc: v.clicks ? round(v.spend / v.clicks, 3) : 0,
    cpm: v.impressions ? round((v.spend / v.impressions) * 1000, 2) : 0,
    conversion: Math.round(v.conversion),
    cpa: v.conversion ? round(v.spend / v.conversion, 2) : 0,
    purchases: Math.round(v.purchases),
    gmv: round(v.gmv),
    roas: v.spend ? round(v.gmv / v.spend, 2) : 0,
    objective: v.objective || '',
  })).filter((v) => v.spend > 0 || v.impressions > 0)
    .sort((a, b) => b.spend - a.spend);

  return {
    start, end,
    totals: {
      spend: round(totSpend), gmv: round(totGmv),
      roas: totSpend ? round(totGmv / totSpend, 2) : 0,
      videos: list.length,
      excludedVideos: excludedKeys.size, // 被排除的品牌/播放量类视频数
    },
    videos: list,
  };
}

function round(n, d = 2) { const p = 10 ** d; return Math.round(n * p) / p; }

module.exports = { configured, getAdvertisers, getVideoReport, listAccounts, uploadVideo, uploadVideoMulti };
