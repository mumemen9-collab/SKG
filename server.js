'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const tiktok = require('./tiktok'); // TikTok 投放数据接入
const minimax = require('./minimax'); // MiniMax 文本转语音（配音）
const llm = require('./llm'); // 大模型接入（一键生成脚本）

// ---------------------------------------------------------------------------
// 路径与常量
// ---------------------------------------------------------------------------
const ROOT = __dirname;
const FFMPEG = path.join(ROOT, 'runtime', 'ffmpeg', 'bin', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'runtime', 'ffmpeg', 'bin', 'ffprobe.exe');
const WHISPER = path.join(ROOT, 'runtime', 'whisper', 'Release', 'whisper-cli.exe');
const WHISPER_MODEL = path.join(ROOT, 'runtime', 'whisper', 'models', 'ggml-base.bin');
const UPLOAD_DIR = path.join(ROOT, 'uploads'); // 临时任务文件（可清理）
const OUTPUT_DIR = path.join(ROOT, 'output'); // 成片输出（可清理）

// 【持久化数据目录】放在 app 文件夹【外面】，独立于代码。
// 这样升级 / 替换 / 清理 D:\Dvideo-tool 都不会动到用户的素材库和脚本库。
// 默认是 app 同级的 Dvideo-tool-data（如 D:\Dvideo-tool-data），可用环境变量 MIXER_DATA_DIR 覆盖。
const DATA_DIR = process.env.MIXER_DATA_DIR || path.join(path.dirname(ROOT), path.basename(ROOT) + '-data');
const LIB_DIR = path.join(DATA_DIR, 'library'); // 素材库：背景音乐 / 配音
const SCRIPT_DIR = path.join(DATA_DIR, 'scripts'); // 脚本库
const HISTORY_DIR = path.join(DATA_DIR, 'history'); // 历史任务记录（持久）
const MATERIALS_DIR = path.join(DATA_DIR, 'materials'); // 视频素材库（按文件夹分类，持久）
const TEMPLATES_DIR = path.join(DATA_DIR, 'templates'); // 混剪设置模版（按产品 SKU 分类，持久）
const PORT = process.env.PORT || 5173;

for (const d of [UPLOAD_DIR, OUTPUT_DIR, path.join(LIB_DIR, 'bgm'), path.join(LIB_DIR, 'voice'), SCRIPT_DIR, HISTORY_DIR, TEMPLATES_DIR, path.join(MATERIALS_DIR, '默认')]) {
  fs.mkdirSync(d, { recursive: true });
}

// 一次性迁移：把早期版本存在 app 内的旧数据搬到外部数据目录，避免本次升级丢数据
(function migrateLegacyData() {
  const moves = [
    [path.join(ROOT, 'library', 'bgm'), path.join(LIB_DIR, 'bgm')],
    [path.join(ROOT, 'library', 'voice'), path.join(LIB_DIR, 'voice')],
    [path.join(ROOT, 'scripts_lib'), SCRIPT_DIR],
  ];
  let moved = 0;
  for (const [oldDir, newDir] of moves) {
    if (!fs.existsSync(oldDir)) continue;
    try {
      for (const f of fs.readdirSync(oldDir)) {
        const src = path.join(oldDir, f);
        const dst = path.join(newDir, f);
        if (fs.statSync(src).isFile() && !fs.existsSync(dst)) {
          try { fs.renameSync(src, dst); } // 同盘直接移动
          catch (_) { fs.copyFileSync(src, dst); fs.unlinkSync(src); } // 跨盘则复制后删除
          moved++;
        }
      }
    } catch (_) {}
  }
  if (moved > 0) console.log(`  已迁移 ${moved} 个旧数据文件到 ${DATA_DIR}`);
})();

// 日志 + 全局异常兜底：任何未捕获错误都记录到 server.log，并且【不让进程退出】
const LOG_FILE = path.join(ROOT, 'server.log');
function log(...a) {
  const line =
    `[${new Date().toISOString()}] ` +
    a.map((x) => (typeof x === 'string' ? x : (x && x.stack) || JSON.stringify(x))).join(' ') +
    '\n';
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  console.log(...a);
}
process.on('uncaughtException', (e) => log('‼ uncaughtException:', e));
process.on('unhandledRejection', (e) => log('‼ unhandledRejection:', e));

const CANVAS = {
  vertical: { w: 1080, h: 1920 },
  horizontal: { w: 1920, h: 1080 },
  square: { w: 1080, h: 1080 },
};

// 任务状态保存在内存里：jobId -> { status, stage, percent, message, clients[], outFile, error }
const jobs = new Map();

// ---------------------------------------------------------------------------
// 上传配置（multer）：视频最多 100 条，外加 1 条背景音乐 + 1 条配音
// ---------------------------------------------------------------------------
const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      const jobDir = path.join(UPLOAD_DIR, req.jobId);
      fs.mkdirSync(jobDir, { recursive: true });
      cb(null, jobDir);
    } catch (e) {
      cb(e);
    }
  },
  filename(req, file, cb) {
    // 生成安全文件名：序号前缀（保证排序/唯一）+ 清洗过的原名 + 扩展名
    const n = (req._fileCount = (req._fileCount || 0) + 1);
    const prefix = String(n).padStart(4, '0');
    cb(null, `${prefix}__${safeName(file.originalname)}`);
  },
});

// 把任意原始文件名清洗成 Windows 合法、纯净的文件名
function safeName(originalname) {
  let name = originalname || 'file';
  // multer 给的非 ASCII 名常是被当作 latin1 的 UTF-8 字节，尝试还原；失败则保留原样
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (!decoded.includes('�')) name = decoded;
  } catch (_) {}
  let ext = path.extname(name);
  ext = ext.replace(/[^.0-9a-zA-Z]/g, '').slice(0, 12); // 扩展名只留字母数字
  let base = path.basename(name, path.extname(name));
  // 去掉 Windows 非法字符 < > : " / \ | ? * 及控制字符
  base = base.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/[. ]+$/g, '').slice(0, 80);
  if (!base) base = 'file';
  return base + ext;
}

const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 110 }, // 单文件最大 4GB
}).fields([
  { name: 'videos', maxCount: 100 },
  { name: 'bgm', maxCount: 1 },
  { name: 'voice', maxCount: 1 },
]);

// 为每次上传分配 jobId（在 multer 解析前就要确定目录）
function assignJobId(req, res, next) {
  req.jobId = crypto.randomBytes(6).toString('hex');
  next();
}

// ---------------------------------------------------------------------------
// FFmpeg / FFprobe 辅助
// ---------------------------------------------------------------------------
function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn(FFPROBE, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      file,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      const v = parseFloat(out.trim());
      resolve(Number.isFinite(v) ? v : 0);
    });
    p.on('error', () => resolve(0));
  });
}

// 运行 ffmpeg，按 -progress 输出回传进度（0..1）。opts.cwd 可指定工作目录
function runFfmpeg(args, expectedDur, onProgress, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, opts.cwd ? { cwd: opts.cwd } : {});
    let stderr = '';
    let buf = '';
    p.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith('out_time_us=')) {
          const us = parseInt(line.slice('out_time_us='.length), 10);
          if (Number.isFinite(us) && expectedDur > 0) {
            onProgress(Math.max(0, Math.min(1, us / 1e6 / expectedDur)));
          }
        }
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}:\n${stderr.slice(-2000)}`));
    });
  });
}

// 根据人声配音生成带时间轴的字幕（SRT）。返回 srt 路径，失败返回 null
function generateSubtitle(voicePath, jobDir) {
  return new Promise((resolve) => {
    if (!fs.existsSync(WHISPER) || !fs.existsSync(WHISPER_MODEL)) {
      log('⚠ 未找到 whisper 引擎或模型，跳过字幕生成');
      return resolve(null);
    }
    const wav = path.join(jobDir, 'voice16k.wav');
    const srtPrefix = path.join(jobDir, 'sub');
    const srtPath = srtPrefix + '.srt';
    // 1) 配音转 16kHz 单声道 wav（whisper 要求）
    const conv = spawn(FFMPEG, ['-y', '-i', voicePath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    conv.on('error', () => resolve(null));
    conv.on('close', (c) => {
      if (c !== 0 || !fs.existsSync(wav)) { log('⚠ 配音转 wav 失败，跳过字幕'); return resolve(null); }
      // 2) whisper 转写为 SRT（-l auto 自动识别中/英文）
      log(`🗣 whisper 转写中 → ${srtPath}`);
      const args = ['-m', WHISPER_MODEL, '-f', wav, '-l', 'auto', '-osrt', '-of', srtPrefix, '-t', '4'];
      const w = spawn(WHISPER, args, { cwd: path.dirname(WHISPER) });
      let werr = '';
      w.stderr.on('data', (d) => { werr += d; if (werr.length > 8000) werr = werr.slice(-8000); });
      w.on('error', (e) => { log('⚠ whisper 启动失败:', e); resolve(null); });
      w.on('close', (code) => {
        // 必须存在、非空、且含有时间轴（-->），否则视为无字幕，避免 libass 打开空文件崩溃
        let ok = false;
        try {
          ok = code === 0 && fs.existsSync(srtPath) &&
            fs.statSync(srtPath).size > 0 &&
            fs.readFileSync(srtPath, 'utf8').includes('-->');
        } catch (_) {}
        if (ok) {
          log(`✓ 字幕生成完成 ${srtPath}`);
          resolve(srtPath);
        } else {
          log(`⚠ 字幕为空或生成失败（配音可能无可识别语音），将不带字幕继续。whisper 退出码 ${code}`);
          try { if (fs.existsSync(srtPath) && fs.statSync(srtPath).size === 0) fs.unlinkSync(srtPath); } catch (_) {}
          resolve(null);
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 进度推送（SSE）
// ---------------------------------------------------------------------------
function setProgress(job, patch) {
  Object.assign(job, patch);
  const payload = JSON.stringify({
    status: job.status,
    stage: job.stage,
    percent: Math.round(job.percent || 0),
    message: job.message || '',
    error: job.error || null,
    ready: job.status === 'done',
    count: job.count || 1,
    done: (job.outputs || []).length, // 已完成的条数
  });
  for (const res of job.clients) {
    res.write(`data: ${payload}\n\n`);
  }
}

// ---------------------------------------------------------------------------
// 混剪核心
// ---------------------------------------------------------------------------
async function runMixJob(jobId, opts) {
  const job = jobs.get(jobId);
  const jobDir = path.join(UPLOAD_DIR, jobId);
  const canvas = CANVAS[opts.canvas] || CANVAS.vertical;
  const fps = opts.fps || 30;
  const clipSeconds = Number(opts.clipSeconds) > 0 ? Number(opts.clipSeconds) : 0;
  const t0 = Date.now();
  const hist = { videos: 0, hasBgm: false, hasVoice: false, hasSub: false };

  try {
    // 一次生成几条（1~5）。多条时每条用不同的片段顺序，得到不同版本
    const count = Math.max(1, Math.min(30, Number(opts.count) || 1));
    job.count = count;

    // 1) 收集片段 ----------------------------------------------------------
    const baseVideos = fs
      .readdirSync(jobDir)
      .filter((f) => f.startsWith('vid__'))
      .map((f) => path.join(jobDir, f));
    if (baseVideos.length === 0) throw new Error('没有可用的视频片段');

    const bgmPath = fileIfExists(jobDir, 'bgm__');
    const voicePath = fileIfExists(jobDir, 'voice__');
    hist.videos = baseVideos.length;
    hist.hasBgm = !!bgmPath;
    hist.hasVoice = !!voicePath;
    hist.nameBase = buildNameBase(opts, voicePath, t0); // 成片命名：日期-配音名-SKU-批次

    // 2) 探测每个片段时长，估算蒙太奇总时长（与顺序无关）------------------
    setProgress(job, { status: 'running', stage: 'probe', percent: 0, message: '正在分析素材…' });
    let montageDur = 0;
    for (const v of baseVideos) {
      const d = await probeDuration(v);
      montageDur += clipSeconds > 0 ? Math.min(d, clipSeconds) : d;
    }
    if (montageDur <= 0) montageDur = baseVideos.length; // 兜底

    // 3) 计算成片目标时长 T（与顺序无关，所有版本一致）--------------------
    let target = montageDur;
    if (opts.durationBasis === 'voice' && voicePath) target = await probeDuration(voicePath);
    else if (opts.durationBasis === 'bgm' && bgmPath) target = await probeDuration(bgmPath);
    if (!(target > 0)) target = montageDur;

    // 4) 根据人声配音生成字幕（只做一次，所有版本共用）-------------------
    let srtPath = null;
    if (opts.subtitles && voicePath) {
      setProgress(job, { stage: 'subtitle', percent: 2, message: '正在根据配音生成字幕…' });
      srtPath = await generateSubtitle(voicePath, jobDir);
      if (!srtPath) setProgress(job, { message: '字幕生成未成功，将不带字幕继续输出…' });
    }
    hist.hasSub = !!srtPath;

    // 5) 片段归一化（只做一次）：把每个片段统一到同一画布/帧率/编码。
    //    之后各条仅用 concat 解复用器流拷贝极速拼接，无需重复缩放编码。
    const { w, h } = canvas;
    const trim = clipSeconds > 0 ? `trim=duration=${clipSeconds},setpts=PTS-STARTPTS,` : '';
    const vf =
      `${trim}scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps},format=yuv420p`;
    const normDir = path.join(jobDir, 'norm');
    fs.mkdirSync(normDir, { recursive: true });
    const normFiles = baseVideos.map((_, i) => path.join(normDir, `n${i}.mp4`));

    const normBase = srtPath ? 8 : 2; // 字幕已占用的进度
    const normSpan = 33; // 归一化阶段占用的进度跨度
    setProgress(job, { stage: 'normalize', percent: normBase, message: `正在预处理 ${baseVideos.length} 个片段…` });
    let normDone = 0;
    await runPool(baseVideos.length, 4, async (i) => {
      await runFfmpegPlain([
        '-y', '-i', baseVideos[i], '-vf', vf, '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '60',
        normFiles[i],
      ]);
      normDone++;
      setProgress(job, {
        percent: normBase + (normDone / baseVideos.length) * normSpan,
        message: `预处理片段 ${normDone}/${baseVideos.length}…`,
      });
    });

    // 6) 循环生成 count 条 -------------------------------------------------
    const montageFile = path.join(jobDir, 'montage.mp4');
    const listFile = path.join(jobDir, 'concat.txt');
    const basePct = normBase + normSpan;
    const per = (100 - basePct) / count; // 每条占的进度份额
    job.outputs = [];

    for (let i = 0; i < count; i++) {
      const no = i + 1;
      const vStart = basePct + i * per;
      // 第 1 条按用户选择的顺序；其余条随机打乱，保证多条各不相同
      const order = i === 0 ? opts.order : 'shuffle';
      const idxOrder = arrangeIndices(baseVideos, order);

      // 6a) 极速拼接：concat 解复用器 + 流拷贝（几乎瞬间，不重新编码）
      fs.writeFileSync(
        listFile,
        idxOrder.map((k) => `file '${normFiles[k].replace(/\\/g, '/')}'`).join('\n')
      );
      setProgress(job, { stage: 'montage', percent: vStart, message: `第 ${no}/${count} 条 · 正在拼接…` });
      await runFfmpegPlain(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', montageFile]);

      // 6b) 循环裁切到 T + 混音（可烧录字幕），输出成片（此步是主要耗时）
      const outFile = path.join(OUTPUT_DIR, `${jobId}_${no}.mp4`);
      const tmpFile = path.join(OUTPUT_DIR, `${jobId}_${no}.tmp.mp4`);
      const { args: finalArgs } = buildFinalArgs({
        montageFile, bgmPath, voicePath, opts, target, fps, outFile: tmpFile, srtPath,
      });
      setProgress(job, { stage: 'mux', percent: vStart + per * 0.08, message: `第 ${no}/${count} 条 · 正在合成输出…` });
      await runFfmpeg(finalArgs, target, (r) =>
        setProgress(job, { percent: vStart + per * 0.08 + r * per * 0.92, message: `第 ${no}/${count} 条 · 输出成片 ${Math.round(r * 100)}%` }),
        { cwd: jobDir } // 让 subtitles 滤镜可用相对路径引用 sub.srt，避免 Windows 盘符冒号转义问题
      );
      fs.renameSync(tmpFile, outFile);
      job.outputs.push(outFile);
      log(`✓ 第 ${no}/${count} 条完成 job=${jobId} → ${outFile}`);
    }

    job.outFile = job.outputs[0];

    // 清理中间文件，释放磁盘（保留 sub.srt 供下载）
    try {
      fs.rmSync(normDir, { recursive: true, force: true });
      for (const f of [montageFile, listFile, path.join(jobDir, 'voice16k.wav')]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    } catch (_) {}

    writeHistory(jobId, {
      status: 'done', count, options: opts, elapsedSec: Math.round((Date.now() - t0) / 1000),
      outputs: job.outputs.map((f) => path.basename(f)), ...hist,
    });
    setProgress(job, { status: 'done', stage: 'done', percent: 100, message: `全部 ${count} 条混剪完成！` });
  } catch (err) {
    log(`✗ 混剪失败 job=${jobId}:`, err);
    writeHistory(jobId, {
      status: 'error', error: String(err.message || err), count: Math.max(1, Math.min(30, Number(opts.count) || 1)),
      options: opts, elapsedSec: Math.round((Date.now() - t0) / 1000), outputs: (job.outputs || []).map((f) => path.basename(f)), ...hist,
    });
    setProgress(job, { status: 'error', error: String(err.message || err), message: '出错了' });
  }
}

// 成片命名规则：日期(MMDD)-脚本名(配音名)-产品SKU-批次  （序号在导出时追加）
function cleanNamePart(s) {
  return String(s || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
function buildNameBase(opts, voicePath, dateMs) {
  const d = new Date(dateMs || Date.now());
  const date = String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  let voiceName = '';
  if (voicePath) voiceName = path.basename(voicePath).replace(/^voice__[a-z0-9]+__/i, '').replace(/\.[^.]+$/, '');
  const parts = [date, cleanNamePart(voiceName), cleanNamePart(opts.sku), cleanNamePart(opts.batch)].filter(Boolean);
  return parts.join('-') || date;
}
function readHistoryRec(jobId) {
  if (!/^[a-z0-9]+$/i.test(jobId || '')) return null;
  try { return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, jobId + '.json'), 'utf8').replace(/^﻿/, '')); } catch (_) { return null; }
}
// 第 n 条成片的导出文件名（下载 / 上传到 TikTok 共用）
function exportName(jobId, n) {
  const base = readHistoryRec(jobId)?.nameBase;
  const name = base ? `${base}-${n}` : `混剪成片_${jobId}_第${n}条`;
  return name + '.mp4';
}

// ---------- 历史任务记录（持久化在外部数据目录） ----------
function writeHistory(jobId, rec) {
  try {
    const o = rec.options || {};
    const record = {
      id: jobId,
      time: Date.now(),
      status: rec.status,
      error: rec.error || null,
      count: rec.count,
      elapsedSec: rec.elapsedSec,
      nameBase: rec.nameBase || null,
      videos: rec.videos, hasBgm: rec.hasBgm, hasVoice: rec.hasVoice, hasSub: rec.hasSub,
      outputs: rec.outputs || [],
      canvas: o.canvas, fps: o.fps, durationBasis: o.durationBasis, order: o.order,
      clipSeconds: o.clipSeconds, audioMode: o.audioMode, subtitles: !!o.subtitles,
      sku: o.sku || '', batch: o.batch || '',
    };
    fs.writeFileSync(path.join(HISTORY_DIR, jobId + '.json'), JSON.stringify(record));
    log(`🗂 已记录历史任务 ${jobId} (${rec.status})`);
  } catch (e) { log('⚠ 写历史任务失败:', e); }
}
function listHistory() {
  try {
    return fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8').replace(/^﻿/, '')); } catch (_) { return null; } })
      .filter(Boolean).sort((a, b) => (b.time || 0) - (a.time || 0));
  } catch (_) { return []; }
}

function fileIfExists(dir, prefix) {
  const f = fs.readdirSync(dir).find((x) => x.startsWith(prefix));
  return f ? path.join(dir, f) : null;
}

// 按指定方式给片段排序，返回索引顺序：name=按文件名 / shuffle=随机打乱 / 其它=上传顺序
function arrangeIndices(base, order) {
  const idx = base.map((_, i) => i);
  if (order === 'name') {
    idx.sort((a, b) => path.basename(base[a]).localeCompare(path.basename(base[b]), 'zh-CN', { numeric: true }));
  } else if (order === 'shuffle') {
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
  }
  return idx;
}

// 简易并发池：对 0..total-1 以最多 concurrency 个并行执行 taskFn(i)
async function runPool(total, concurrency, taskFn) {
  let next = 0;
  async function worker() {
    while (next < total) {
      const i = next++;
      await taskFn(i);
    }
  }
  const workers = [];
  for (let k = 0; k < Math.min(concurrency, total); k++) workers.push(worker());
  await Promise.all(workers);
}

// 运行 ffmpeg（无进度解析版，用于归一化/拼接等快速步骤）
function runFfmpegPlain(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, opts.cwd ? { cwd: opts.cwd } : {});
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${c}:\n${err.slice(-1500)}`))));
  });
}

// 构建第二段 ffmpeg 参数（视频循环裁切 + 音频混合 + 可选字幕烧录）
function buildFinalArgs({ montageFile, bgmPath, voicePath, opts, target, fps, outFile, srtPath }) {
  const args = ['-y'];
  // 输入 0：蒙太奇（无限循环，靠 -t 截断）
  args.push('-stream_loop', '-1', '-i', montageFile);

  let idx = 1;
  let bgmIdx = -1;
  let voiceIdx = -1;
  if (bgmPath) {
    args.push('-stream_loop', '-1', '-i', bgmPath); // 背景音乐循环铺满
    bgmIdx = idx++;
  }
  if (voicePath) {
    args.push('-i', voicePath); // 配音播放一次
    voiceIdx = idx++;
  }

  const voiceVol = clampVol(opts.voiceVolume, 1.0);
  const bgmVol = clampVol(opts.bgmVolume, opts.audioMode === 'duck' ? 0.8 : 0.22);

  let audioFilter = null;
  let mapAudio = null;

  if (bgmIdx >= 0 && voiceIdx >= 0) {
    if (opts.audioMode === 'duck') {
      // 配音作为侧链，自动压低背景音乐（ducking）
      audioFilter =
        `[${voiceIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${voiceVol},asplit=2[vo1][vo2];` +
        `[${bgmIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${bgmVol}[bg];` +
        `[bg][vo2]sidechaincompress=threshold=0.04:ratio=10:attack=15:release=350[bgd];` +
        `[vo1][bgd]amix=inputs=2:normalize=0:duration=longest[aout]`;
    } else {
      audioFilter =
        `[${voiceIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${voiceVol}[vo];` +
        `[${bgmIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${bgmVol}[bg];` +
        `[vo][bg]amix=inputs=2:normalize=0:duration=longest[aout]`;
    }
    mapAudio = '[aout]';
  } else if (voiceIdx >= 0) {
    audioFilter = `[${voiceIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${voiceVol}[aout]`;
    mapAudio = '[aout]';
  } else if (bgmIdx >= 0) {
    audioFilter = `[${bgmIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${bgmVol}[aout]`;
    mapAudio = '[aout]';
  }

  // 视频滤镜：如有字幕则烧录（subtitles 滤镜）。cwd 已设为 jobDir，故用相对文件名
  let mapVideo = '0:v';
  let videoFilter = null;
  if (srtPath) {
    // 注意：subtitles 滤镜对 SRT 按 288 高的虚拟分辨率渲染再等比放大到输出分辨率，
    // 因此字号/边距用相对 288 基准的固定值即可，自动适配任意画布尺寸。
    const fontSize = 13; // 小字号，参考“Hey Meta,”那种清爽样式
    const marginV = 60; // 抬高到偏下三分之一处（288 基准，距底部约 1/5）
    const style =
      `FontName=Microsoft YaHei,FontSize=${fontSize},` +
      `PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,` +
      `BorderStyle=1,Outline=1,Shadow=1,Alignment=2,MarginL=60,MarginR=60,MarginV=${marginV}`;
    videoFilter = `[0:v]subtitles=${path.basename(srtPath)}:force_style='${style}'[v]`;
    mapVideo = '[v]';
  }

  // 合并视频/音频滤镜到一个 filter_complex
  const filters = [];
  if (videoFilter) filters.push(videoFilter);
  if (audioFilter) filters.push(audioFilter);
  if (filters.length) args.push('-filter_complex', filters.join(';'));

  args.push('-map', mapVideo);
  if (mapAudio) args.push('-map', mapAudio);

  args.push(
    '-t', target.toFixed(3),
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p'
  );
  if (mapAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outFile);
  return { args };
}

function clampVol(v, def) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, 4);
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '4mb' })); // 脚本可能较长

// 首页：给 app.js / style.css 注入版本号（每次服务重启即变），强制浏览器拿最新前端
const ASSET_VER = Date.now();
app.get('/', (req, res) => {
  try {
    let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    html = html.replace(/(app\.js|style\.css)(\?v=\d+)?/g, `$1?v=${ASSET_VER}`);
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.type('html').send(html);
  } catch (e) {
    res.status(500).send('加载首页失败：' + e.message);
  }
});

// 禁用前端静态资源缓存，保证升级后刷新即生效（避免旧缓存导致“显示不对”）
app.use(express.static(path.join(ROOT, 'public'), {
  etag: false,
  index: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, must-revalidate'),
}));

// 上传素材
app.post('/api/upload', assignJobId, (req, res) => {
  log(`↑ 上传开始 job=${req.jobId}`);
  req.on('aborted', () => log(`⚠ 上传被客户端中断 job=${req.jobId}`));
  req.on('error', (e) => log(`⚠ 上传请求流错误 job=${req.jobId}:`, e));
  upload(req, res, (err) => {
    if (err) {
      log(`✗ 上传失败 job=${req.jobId}:`, err);
      if (res.headersSent) return;
      return res.status(400).json({ error: '上传失败：' + (err.message || err) });
    }
    try {
      const jobDir = path.join(UPLOAD_DIR, req.jobId);
      fs.mkdirSync(jobDir, { recursive: true }); // 只选素材库、无本地文件时 multer 不会建目录，这里兜底
      const body = req.body || {};
      // 重命名为带类型前缀，便于混剪阶段识别
      const files = req.files || {};
      (files.videos || []).forEach((f) => renameWithPrefix(jobDir, f, 'vid__'));
      (files.bgm || []).forEach((f) => renameWithPrefix(jobDir, f, 'bgm__'));
      (files.voice || []).forEach((f) => renameWithPrefix(jobDir, f, 'voice__'));

      // 从「视频素材库」选中的素材 → 复制进任务目录作为片段
      let matCount = 0;
      try {
        const refs = JSON.parse(body.materials || '[]');
        let i = 0;
        for (const r of (Array.isArray(refs) ? refs : [])) {
          const src = findMaterial(r.folder, r.id);
          if (src) {
            const seq = String(++i).padStart(4, '0');
            fs.copyFileSync(src, path.join(jobDir, `vid__lib${seq}__` + path.basename(src).replace(/^[a-z0-9]+__/i, '')));
            matCount++;
          }
        }
      } catch (_) {}

      // 处理背景音乐 / 配音的「音频库」：自动保存新上传的 / 引用已保存的
      for (const type of ['bgm', 'voice']) {
        const uploaded = (files[type] || [])[0];
        if (uploaded) {
          // 新上传的自动存入库（同名自动去重）
          try { saveToLibrary(type, path.join(jobDir, type + '__' + path.basename(uploaded.path)), uploaded.originalname); }
          catch (e) { log(`⚠ 自动保存音频库失败 ${type}:`, e); }
        } else if (body[`${type}LibRef`]) {
          // 从音频库弹窗选的 {folder,id}
          try { const ref = JSON.parse(body[`${type}LibRef`]); const f = findAudio(type, ref.folder, ref.id); if (f) fs.copyFileSync(f, path.join(jobDir, `${type}__` + path.basename(f))); } catch (_) {}
        } else if (body[`${type}LibId`]) {
          // 兼容旧的 id 引用
          const libFile = findLibraryFile(type, body[`${type}LibId`]);
          if (libFile) fs.copyFileSync(libFile, path.join(jobDir, `${type}__` + path.basename(libFile)));
        }
      }

      const hasBgm = !!(files.bgm || [])[0] || !!body.bgmLibId || !!body.bgmLibRef;
      const hasVoice = !!(files.voice || [])[0] || !!body.voiceLibId || !!body.voiceLibRef;
      const totalVideos = (files.videos || []).length + matCount;
      log(`✓ 上传完成 job=${req.jobId} 视频=${totalVideos}(其中素材库${matCount}) bgm=${hasBgm} voice=${hasVoice}`);
      if (res.headersSent) return;
      res.json({
        jobId: req.jobId,
        videos: totalVideos,
        bgm: hasBgm,
        voice: hasVoice,
      });
    } catch (e) {
      log(`✗ 上传后处理出错 job=${req.jobId}:`, e);
      if (!res.headersSent) res.status(500).json({ error: '服务器处理上传时出错：' + (e.message || e) });
    }
  });
});

function renameWithPrefix(dir, file, prefix) {
  const base = path.basename(file.path);
  const dst = path.join(dir, prefix + base);
  try { fs.renameSync(file.path, dst); } catch (_) {}
}

// ---------- 音频库（背景音乐 / 配音，按文件夹分类）----------
const AUDIO_EXT = /\.(mp3|wav|aac|m4a|flac|ogg|opus|wma)$/i;
function audioType(type) { return type === 'voice' ? 'voice' : 'bgm'; }
function audioTypeDir(type) { return path.join(LIB_DIR, audioType(type)); }
function audioFolderDir(type, folder) { return path.join(audioTypeDir(type), safeFolder(folder)); }

// 旧的扁平文件迁移进「默认」文件夹（一次性）
(function migrateAudioLib() {
  for (const type of ['bgm', 'voice']) {
    const dir = audioTypeDir(type);
    fs.mkdirSync(path.join(dir, '默认'), { recursive: true });
    try {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        try {
          if (fs.statSync(full).isFile() && f.includes('__') && AUDIO_EXT.test(f)) {
            const dst = path.join(dir, '默认', f);
            if (!fs.existsSync(dst)) fs.renameSync(full, dst);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
})();

function listAudioFolders(type) {
  try {
    return fs.readdirSync(audioTypeDir(type), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== '_incoming')
      .map((d) => ({ name: d.name, count: (() => { try { return fs.readdirSync(path.join(audioTypeDir(type), d.name)).filter((f) => AUDIO_EXT.test(f)).length; } catch (_) { return 0; } })() }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  } catch (_) { return []; }
}
function listAudio(type, folder) {
  try {
    return fs.readdirSync(audioFolderDir(type, folder)).filter((f) => f.includes('__') && AUDIO_EXT.test(f))
      .map((f) => ({ id: f.slice(0, f.indexOf('__')), name: f.slice(f.indexOf('__') + 2), folder: safeFolder(folder) }));
  } catch (_) { return []; }
}
function findAudio(type, folder, id) {
  if (!/^[a-z0-9]+$/i.test(id || '')) return null;
  try { const f = fs.readdirSync(audioFolderDir(type, folder)).find((x) => x.startsWith(id + '__') && AUDIO_EXT.test(x)); return f ? path.join(audioFolderDir(type, folder), f) : null; } catch (_) { return null; }
}
// 跨文件夹按 id 找（兼容旧的 bgmLibId/voiceLibId 引用）
function findAudioAnyFolder(type, id) {
  for (const fo of listAudioFolders(type)) { const f = findAudio(type, fo.name, id); if (f) return f; }
  return null;
}

// 自动保存上传的音频到库（默认文件夹，同名去重）
function saveToLibrary(type, srcPath, originalName) {
  const name = safeName(originalName);
  for (const fo of listAudioFolders(type)) if (listAudio(type, fo.name).some((x) => x.name === name)) return { name, folder: fo.name };
  const id = crypto.randomBytes(6).toString('hex');
  fs.mkdirSync(audioFolderDir(type, '默认'), { recursive: true });
  fs.copyFileSync(srcPath, path.join(audioFolderDir(type, '默认'), `${id}__${name}`));
  log(`★ 已自动保存到${type === 'voice' ? '配音' : '背景音乐'}库: ${name}`);
  return { id, name, folder: '默认' };
}
function findLibraryFile(type, id) { return id ? findAudioAnyFolder(type, id) : null; }

// 把配音 buffer 存入「配音库」指定文件夹（按脚本 SKU）。同名则覆盖（便于重新生成）。
function saveVoiceBuffer(buffer, baseName, folder) {
  const safeBase = safeName(String(baseName || 'voice').replace(/\.[^.]+$/, '')); // 去掉扩展再清洗
  const name = safeBase.replace(/\.[^.]+$/, '') + '.mp3';
  const dir = audioFolderDir('voice', folder || '默认');
  fs.mkdirSync(dir, { recursive: true });
  // 同名覆盖：删掉该文件夹里同名旧文件
  try { for (const f of fs.readdirSync(dir)) { if (f.includes('__') && f.slice(f.indexOf('__') + 2) === name) fs.unlinkSync(path.join(dir, f)); } } catch (_) {}
  const id = crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(path.join(dir, `${id}__${name}`), buffer);
  return { id, name, folder: safeFolder(folder || '默认') };
}

// ---------- 音频库接口（背景音乐 / 配音，文件夹版，type=bgm|voice）----------
const okAudioType = (t) => ['bgm', 'voice'].includes(t);
const audioUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) { const d = path.join(audioTypeDir(okAudioType(req.params.type) ? req.params.type : 'bgm'), '_incoming'); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename(req, file, cb) { cb(null, crypto.randomBytes(8).toString('hex')); },
  }),
  limits: { fileSize: 1024 * 1024 * 1024, files: 100 },
}).array('audios', 100);

// 文件夹：列表 / 新建 / 删除 / 重命名
app.get('/api/audiolib/:type/folders', (req, res) => { if (!okAudioType(req.params.type)) return res.status(400).json({ error: '类型错误' }); res.json(listAudioFolders(req.params.type)); });
app.post('/api/audiolib/:type/folder', (req, res) => {
  if (!okAudioType(req.params.type)) return res.status(400).json({ error: '类型错误' });
  const name = safeFolder((req.body || {}).name);
  try { fs.mkdirSync(audioFolderDir(req.params.type, name), { recursive: true }); res.json({ ok: true, name }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.delete('/api/audiolib/:type/folder/:name', (req, res) => {
  if (!okAudioType(req.params.type)) return res.status(400).json({ error: '类型错误' });
  const name = safeFolder(req.params.name);
  if (name === '默认') return res.status(400).json({ error: '默认文件夹不可删除' });
  try { fs.rmSync(audioFolderDir(req.params.type, name), { recursive: true, force: true }); } catch (_) {}
  res.json({ ok: true });
});
app.post('/api/audiolib/:type/folder/rename', (req, res) => {
  if (!okAudioType(req.params.type)) return res.status(400).json({ error: '类型错误' });
  const oldName = safeFolder((req.body || {}).oldName), newName = safeFolder((req.body || {}).newName);
  if (!newName) return res.status(400).json({ error: '新名称无效' });
  if (oldName === '默认') return res.status(400).json({ error: '默认文件夹不可改名' });
  const oldDir = audioFolderDir(req.params.type, oldName), newDir = audioFolderDir(req.params.type, newName);
  if (!fs.existsSync(oldDir)) return res.status(404).json({ error: '文件夹不存在' });
  if (fs.existsSync(newDir)) return res.status(400).json({ error: '已存在同名文件夹' });
  try { fs.renameSync(oldDir, newDir); res.json({ ok: true, name: newName }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// 音频：列表（folder=__all__ 全部）/ 试听 / 删除 / 移动
app.get('/api/audiolib/:type', (req, res) => {
  if (!okAudioType(req.params.type)) return res.status(400).json({ error: '类型错误' });
  const folder = req.query.folder;
  if (!folder || folder === '__all__') { let all = []; for (const f of listAudioFolders(req.params.type)) all = all.concat(listAudio(req.params.type, f.name)); return res.json(all); }
  res.json(listAudio(req.params.type, folder));
});
app.get('/api/audiolib/:type/file/:folder/:id', (req, res) => {
  if (!okAudioType(req.params.type)) return res.status(400).end();
  const f = findAudio(req.params.type, req.params.folder, req.params.id);
  if (!f) return res.status(404).end();
  res.sendFile(f);
});
app.delete('/api/audiolib/:type/:folder/:id', (req, res) => {
  if (!okAudioType(req.params.type)) return res.status(400).json({ error: '类型错误' });
  const f = findAudio(req.params.type, req.params.folder, req.params.id);
  if (f) { try { fs.unlinkSync(f); } catch (_) {} }
  res.json({ ok: true });
});
app.post('/api/audiolib/:type/move', (req, res) => {
  if (!okAudioType(req.params.type)) return res.status(400).json({ error: '类型错误' });
  const { items, toFolder } = req.body || {};
  if (!Array.isArray(items) || !items.length || !toFolder) return res.status(400).json({ error: '参数缺失' });
  const to = safeFolder(toFolder); const toDir = audioFolderDir(req.params.type, to); fs.mkdirSync(toDir, { recursive: true });
  let moved = 0;
  for (const it of items) {
    if (safeFolder(it.folder) === to) continue;
    const src = findAudio(req.params.type, it.folder, it.id);
    if (!src) continue;
    try { fs.renameSync(src, path.join(toDir, path.basename(src))); moved++; } catch (_) {}
  }
  res.json({ ok: true, moved });
});
// 上传音频入库
app.post('/api/audiolib/:type/upload', (req, res) => {
  if (!okAudioType(req.params.type)) return res.status(400).json({ error: '类型错误' });
  audioUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: '上传失败：' + (err.message || err) });
    try {
      const folder = safeFolder((req.body || {}).folder);
      const dir = audioFolderDir(req.params.type, folder); fs.mkdirSync(dir, { recursive: true });
      const saved = [];
      for (const file of (req.files || [])) {
        const id = crypto.randomBytes(6).toString('hex');
        const name = safeName(file.originalname);
        const dst = path.join(dir, `${id}__${name}`);
        try { fs.renameSync(file.path, dst); } catch (_) { fs.copyFileSync(file.path, dst); try { fs.unlinkSync(file.path); } catch (_) {} }
        saved.push({ id, name, folder });
      }
      log(`📁 ${req.params.type === 'voice' ? '配音' : '背景音乐'}入库 ${saved.length} 个 → 「${folder}」`);
      res.json({ ok: true, saved });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
});

// ---------- 脚本库 ----------
function scriptPath(id) {
  // 防目录穿越：只允许字母数字
  if (!/^[a-z0-9]+$/i.test(id || '')) return null;
  return path.join(SCRIPT_DIR, `${id}.json`);
}
function readScript(id) {
  const p = scriptPath(id);
  if (!p || !fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; }
}
function listAllScripts() {
  try {
    return fs.readdirSync(SCRIPT_DIR).filter((f) => f.endsWith('.json')).map((f) => readScript(f.slice(0, -5))).filter(Boolean);
  } catch (_) { return []; }
}

// ---------- 脚本 SKU 分类（按产品 SKU 给脚本分组）----------
const SKU_REGISTRY = path.join(SCRIPT_DIR, '_skus.json'); // 注册表：保证空 SKU 也能显示、顺序稳定
const DEFAULT_SKU = 'K5-3 PRO';
function readSkuRegistry() {
  try { const a = JSON.parse(fs.readFileSync(SKU_REGISTRY, 'utf8').replace(/^﻿/, '')); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch (_) { return []; }
}
function writeSkuRegistry(list) {
  const uniq = [...new Set((list || []).map((s) => String(s).trim()).filter(Boolean))];
  try { fs.writeFileSync(SKU_REGISTRY, JSON.stringify(uniq)); } catch (_) {}
  return uniq;
}
function scriptSku(s) { return (s && typeof s.sku === 'string' && s.sku.trim()) ? s.sku.trim() : DEFAULT_SKU; }
function listSkus() {
  const counts = {};
  for (const s of listAllScripts()) { const k = scriptSku(s); counts[k] = (counts[k] || 0) + 1; }
  const names = new Set([...readSkuRegistry(), ...Object.keys(counts), DEFAULT_SKU]);
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((name) => ({ name, count: counts[name] || 0 }));
}
function registerSku(name) {
  const n = String(name || '').trim(); if (!n) return;
  const reg = readSkuRegistry(); if (!reg.includes(n)) { reg.push(n); writeSkuRegistry(reg); }
}

// 迁移：给没有 sku 的旧脚本补默认 SKU（K5-3 PRO），并初始化注册表（一次性）
(function migrateScriptSku() {
  let reg = readSkuRegistry();
  if (!reg.length) reg = [DEFAULT_SKU];
  try {
    for (const f of fs.readdirSync(SCRIPT_DIR)) {
      if (!f.endsWith('.json') || f === '_skus.json') continue;
      const id = f.slice(0, -5);
      const s = readScript(id);
      if (!s) continue;
      if (typeof s.sku !== 'string' || !s.sku.trim()) {
        s.sku = DEFAULT_SKU;
        try { fs.writeFileSync(scriptPath(id), JSON.stringify(s)); } catch (_) {}
      }
      if (!reg.includes(s.sku)) reg.push(s.sku);
    }
  } catch (_) {}
  writeSkuRegistry(reg);
})();

// 把脚本名与投放视频名做匹配（广告名通常包含脚本名）
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9一-龥]+/g, '');
function splitSentences(t) {
  return String(t || '').replace(/\r/g, '').split(/(?<=[。！？!?\n])/).map((x) => x.trim()).filter(Boolean);
}

// 根据已有脚本推导命名要素：下一个 N 序号 + 产品名
function deriveNaming(scripts) {
  let maxN = 0;
  const prodCount = {};
  for (const s of scripts) {
    const t = (s.title || '').trim();
    const mn = /^N(\d+)/i.exec(t);
    if (mn) maxN = Math.max(maxN, parseInt(mn[1], 10));
    const mp = /^N\d+[-_ ]+([A-Za-z0-9]+)/i.exec(t); // N1-K5 → K5
    if (mp) prodCount[mp[1]] = (prodCount[mp[1]] || 0) + 1;
  }
  const product = Object.entries(prodCount).sort((a, b) => b[1] - a[1])[0]?.[0] || 'K5';
  return { nextN: 'N' + (maxN + 1), product };
}

// 把模型给的名字清洗成规范命名：英文、N 系列开头、含产品名、连字符
function sanitizeScriptName(title, nextN, product) {
  let t = String(title || '').replace(/\s+/g, '-').replace(/[^A-Za-z0-9\-_]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!t) t = `${nextN}-${product}-AIFused`;
  if (!/^N\d+/i.test(t)) t = `${nextN}-${t}`;
  if (product && !new RegExp(product, 'i').test(t)) {
    t = t.replace(/^(N\d+)-?/i, `$1-${product}-`).replace(/-+/g, '-').replace(/^-|-$/g, '');
  }
  return t.slice(0, 60);
}

// 一键生成：结合脚本库 + 最新投放数据，融合出一条新草稿
async function generateFusedScript(start, end) {
  const scripts = listAllScripts();
  if (!scripts.length) throw new Error('脚本库为空，先保存一些脚本');
  const rep = await tiktok.getVideoReport(start, end);

  const matched = [];
  for (const s of scripts) {
    const ns = normName(s.title);
    if (ns.length < 4) continue;
    const hits = rep.videos.filter((v) => { const nv = normName(v.name); return nv.includes(ns) || ns.includes(nv); });
    if (!hits.length) continue;
    const m = hits.reduce((a, v) => {
      a.spend += v.spend; a.impressions += v.impressions; a.clicks += v.clicks; a.conversion += v.conversion; a.gmv += v.gmv; return a;
    }, { spend: 0, impressions: 0, clicks: 0, conversion: 0, gmv: 0 });
    m.ctr = m.impressions ? +(m.clicks / m.impressions * 100).toFixed(2) : 0;
    m.roas = m.spend ? +(m.gmv / m.spend).toFixed(2) : 0;
    matched.push({ title: s.title, content: s.content, m, videos: hits.length });
  }
  if (!matched.length) throw new Error('没有能与投放数据对应上的脚本（请确认广告名里包含脚本名）');

  // 综合得分排序：优先 ROAS，其次转化，再 CTR，最后花费（有数据的优先）
  const score = (x) => x.m.roas * 1000 + x.m.conversion * 100 + x.m.ctr * 10 + x.m.spend * 0.01;
  const byScore = [...matched].sort((a, b) => score(b) - score(a));
  const byCtr = [...matched].sort((a, b) => b.m.ctr - a.m.ctr);
  const byConv = [...matched].sort((a, b) => b.m.conversion - a.m.conversion || b.m.roas - a.m.roas);

  const d = new Date();
  const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const ranking = byScore.slice(0, 8).map((s) => ({
    title: s.title, spend: +s.m.spend.toFixed(2), ctr: s.m.ctr, conversion: s.m.conversion, gmv: +s.m.gmv.toFixed(2), roas: s.m.roas, videos: s.videos,
  }));

  // 计算命名规则要用的：下一个 N 序号 + 产品名（参考已有命名）
  const { nextN, product } = deriveNaming(scripts);

  // 有大模型 → AI 生成；否则离线拼装兜底
  if (llm.configured()) {
    const top = byScore.slice(0, 6);
    const samples = top.map((s, i) =>
      `【脚本${i + 1}：${s.title}】投放数据：花费$${s.m.spend.toFixed(2)}，曝光${s.m.impressions}，CTR ${s.m.ctr}%，转化${s.m.conversion}，GMV$${s.m.gmv.toFixed(2)}，ROAS ${s.m.roas}\n${s.content}`
    ).join('\n\n----------\n\n');
    const sys = '你是资深的 TikTok 短视频带货口播脚本编剧。你会分析已有脚本的真实投放数据，提炼出转化效果最好的钩子、卖点和号召方式，写出一条全新的、更可能爆的口播脚本，并按规则起一个英文名。';
    const user =
      `下面是同一款产品的多条口播脚本及它们的真实 TikTok 投放数据（按综合表现排序，越靠前越好）：\n\n${samples}\n\n` +
      `请融合高表现脚本的优点（钩子/卖点/节奏/CTA），写【一条全新的】口播脚本，用于同款产品的 TikTok 带货短视频。\n` +
      `脚本要求：与样本【同一种语言】；开头 3 秒强钩子抓痛点；中间清晰讲卖点/使用场景；结尾有紧迫感的行动号召；口语化、可直接配音；约 30-45 秒。\n\n` +
      `严格按下面格式输出（不要任何额外解释）：\n` +
      `第一行： TITLE: <脚本英文名>\n` +
      `第二行开始： 脚本正文\n\n` +
      `<脚本英文名> 命名规则（全英文、用连字符连接、不要空格）：\n` +
      `1) 因为是全新脚本，以 N 系列开头，用 ${nextN}；\n` +
      `2) 必须包含产品名 ${product}；\n` +
      `3) 末尾用 2-4 个英文词概括这条脚本最大的特色/改动（如开场钩子或卖点角度）。\n` +
      `例如： ${nextN}-${product}-MorningPainTruckerHook`;
    const aiText = await llm.chat(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      { temperature: 0.85, max_tokens: 1300 }
    );
    // 解析 TITLE 行 + 正文
    const lines = aiText.replace(/```/g, '').split('\n');
    const tIdx = lines.findIndex((l) => /^\s*TITLE\s*[:：]/i.test(l));
    let title, content;
    if (tIdx >= 0) {
      title = lines[tIdx].replace(/^\s*TITLE\s*[:：]/i, '').trim().replace(/^["'""]|["'""]$/g, '');
      content = lines.slice(tIdx + 1).join('\n').trim();
    } else { content = aiText.trim(); title = ''; }
    title = sanitizeScriptName(title, nextN, product);
    if (!content) content = aiText.trim();
    return {
      draft: { title, content },
      ranking, matchedCount: matched.length, totalScripts: scripts.length, ai: true, model: llm.modelName(),
    };
  }

  // —— 离线拼装兜底 ——
  const hookSrc = byCtr[0], bodySrc = byScore[0], ctaSrc = byConv[0];
  const hook = splitSentences(hookSrc.content).slice(0, 2).join(' ');
  const bodyS = splitSentences(bodySrc.content);
  const body = bodyS.length > 4 ? bodyS.slice(1, -1).join(' ') : bodyS.join(' ');
  const cta = splitSentences(ctaSrc.content).slice(-2).join(' ');
  const content =
    `【数据优选 · 融合草稿】投放区间 ${rep.start} ~ ${rep.end}，请润色后再用。\n\n` +
    `— 强开头（CTR 最高：${hookSrc.title} · CTR ${hookSrc.m.ctr}%）—\n${hook}\n\n` +
    `— 主体卖点（综合最佳：${bodySrc.title} · ROAS ${bodySrc.m.roas} · 花费$${bodySrc.m.spend.toFixed(2)}）—\n${body}\n\n` +
    `— 行动号召（转化最高：${ctaSrc.title} · 转化 ${ctaSrc.m.conversion}）—\n${cta}`;
  return { draft: { title: `${nextN}-${product}-DataFused`, content }, ranking, matchedCount: matched.length, totalScripts: scripts.length, ai: false };
}

// 列出所有脚本（带摘要，按时间倒序）
app.get('/api/scripts', (req, res) => {
  const sku = req.query.sku ? String(req.query.sku) : '';
  let items = [];
  try {
    items = fs.readdirSync(SCRIPT_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readScript(f.slice(0, -5)))
      .filter(Boolean)
      .map((s) => ({ id: s.id, title: s.title, sku: scriptSku(s), preview: (s.content || '').replace(/\s+/g, ' ').slice(0, 60), created: s.created }))
      .filter((s) => !sku || sku === '__all__' || s.sku === sku)
      .sort((a, b) => (b.created || 0) - (a.created || 0));
  } catch (_) {}
  res.json(items);
});

// SKU 分类：列表（{name,count}）
app.get('/api/scripts/skus', (req, res) => { res.json(listSkus()); });

// SKU 分类：新建
app.post('/api/scripts/skus', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'SKU 名称为空' });
  if (name.length > 40) return res.status(400).json({ error: 'SKU 名称过长' });
  registerSku(name);
  res.json({ ok: true, skus: listSkus() });
});

// SKU 分类：重命名（连同其下脚本一起改）
app.post('/api/scripts/skus/rename', (req, res) => {
  const from = String((req.body && req.body.from) || '').trim();
  const to = String((req.body && req.body.to) || '').trim();
  if (!from || !to) return res.status(400).json({ error: '参数不全' });
  let moved = 0;
  for (const s of listAllScripts()) {
    if (scriptSku(s) === from) { s.sku = to; try { fs.writeFileSync(scriptPath(s.id), JSON.stringify(s)); moved++; } catch (_) {} }
  }
  writeSkuRegistry(readSkuRegistry().map((x) => (x === from ? to : x)));
  res.json({ ok: true, moved, skus: listSkus() });
});

// SKU 分类：删除（其下脚本移到默认 SKU）
app.delete('/api/scripts/skus/:name', (req, res) => {
  const name = String(req.params.name || '').trim();
  if (!name) return res.status(400).json({ error: '参数不全' });
  const fallback = readSkuRegistry().filter((x) => x !== name)[0] || DEFAULT_SKU;
  let moved = 0;
  for (const s of listAllScripts()) {
    if (scriptSku(s) === name) { s.sku = fallback; try { fs.writeFileSync(scriptPath(s.id), JSON.stringify(s)); moved++; } catch (_) {} }
  }
  writeSkuRegistry(readSkuRegistry().filter((x) => x !== name));
  res.json({ ok: true, moved, fallback, skus: listSkus() });
});

// 把脚本归类到某 SKU（批量）
app.post('/api/scripts/move', (req, res) => {
  const ids = (req.body && req.body.ids) || [];
  const sku = String((req.body && req.body.sku) || '').trim();
  if (!Array.isArray(ids) || !ids.length || !sku) return res.status(400).json({ error: '参数不全' });
  let moved = 0;
  for (const id of ids) {
    const s = readScript(id);
    if (s) { s.sku = sku; try { fs.writeFileSync(scriptPath(id), JSON.stringify(s)); moved++; } catch (_) {} }
  }
  registerSku(sku);
  res.json({ ok: true, moved });
});

// ---------- MiniMax 配音生成（脚本 → 配音，存入配音库，按脚本命名）----------
// 状态：是否已配置 + 可选语音列表
app.get('/api/tts/status', async (req, res) => {
  if (!minimax.configured()) return res.json({ configured: false, voices: [], defaultVoice: '' });
  let voiceId = '';
  try { voiceId = minimax.loadConfig().voiceId; } catch (_) {}
  let voices;
  try { voices = await minimax.listVoices(); } // 账户全部系统音色（303个）
  catch (e) { voices = minimax.VOICES.map((v) => ({ id: v.id, name: v.label })); } // 拉取失败回退到精选
  res.json({ configured: true, voices, defaultVoice: voiceId, models: minimax.MODELS, emotions: minimax.EMOTIONS, langs: minimax.LANGS });
});

// 生成配音：传 scriptId（用脚本正文+标题+SKU），或直接传 text/name/sku
app.post('/api/tts', async (req, res) => {
  if (!minimax.configured()) return res.status(400).json({ error: '未配置 MiniMax 凭证' });
  const b = req.body || {};
  let text = String(b.text || '');
  let name = String(b.name || '').trim();
  let sku = String(b.sku || '').trim();
  if (b.scriptId) {
    const s = readScript(String(b.scriptId));
    if (!s) return res.status(404).json({ error: '脚本不存在' });
    text = s.content || '';
    name = name || s.title || '配音';
    sku = sku || scriptSku(s);
  }
  if (!text.trim()) return res.status(400).json({ error: '脚本内容为空' });
  if (!sku) sku = DEFAULT_SKU;
  if (!name) name = '配音_' + Date.now();
  const ttsOpts = {
    voiceId: b.voiceId || undefined,
    model: b.model || undefined,
    speed: b.speed != null ? Number(b.speed) : undefined,
    vol: b.vol != null ? Number(b.vol) : undefined,
    pitch: b.pitch != null ? Number(b.pitch) : undefined,
    emotion: b.emotion || undefined,
    languageBoost: b.languageBoost || undefined,
  };
  try {
    log(`🎙️ 生成配音「${name}」[${sku}] 字数=${text.length} 语音=${b.voiceId || '默认'} 模型=${b.model || '默认'}`);
    const out = await minimax.tts(text, ttsOpts);
    const saved = saveVoiceBuffer(out.buffer, name, sku);
    registerSku(sku); // 顺带让该 SKU 在脚本侧也登记（音频文件夹已建）
    log(`✓ 配音已存入配音库[${saved.folder}] ${saved.name}  ${(out.durationMs / 1000).toFixed(1)}s ${out.bytes}B`);
    res.json({ ok: true, name: saved.name, folder: saved.folder, id: saved.id, durationSec: +(out.durationMs / 1000).toFixed(1), bytes: out.bytes });
  } catch (e) {
    log('✗ 生成配音失败:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 试听：用某音色念一句样例，直接返回音频（不保存到库）
function pickSample(voiceId) {
  const id = String(voiceId || '');
  if (/^English/i.test(id)) return { text: "Hi! This little device melted away my neck pain in just three weeks.", boost: 'English' };
  if (/^(male|female|presenter|audiobook|clever|charming|junlang|lovely|cute|badao|qn|Chinese)/i.test(id)) return { text: '你好，这款小设备只用三周，就缓解了我多年的颈部疼痛。', boost: 'Chinese' };
  return { text: 'Hello! This is a quick voice sample for you to preview.', boost: 'auto' };
}
app.post('/api/tts/preview', async (req, res) => {
  if (!minimax.configured()) return res.status(400).json({ error: '未配置 MiniMax 凭证' });
  const voiceId = String((req.body || {}).voiceId || '').trim();
  if (!voiceId) return res.status(400).json({ error: '缺少音色' });
  const b = req.body || {};
  const sample = pickSample(voiceId);
  try {
    const out = await minimax.tts(sample.text, {
      voiceId,
      model: b.model || undefined,
      speed: b.speed != null ? Number(b.speed) : undefined,
      vol: b.vol != null ? Number(b.vol) : undefined,
      pitch: b.pitch != null ? Number(b.pitch) : undefined,
      emotion: b.emotion || undefined,
      languageBoost: b.languageBoost || sample.boost,
    });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(out.buffer);
  } catch (e) {
    log('✗ 试听失败:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- 混剪设置模版（按产品 SKU 分类）----------
function templatePath(id) {
  if (!/^[a-z0-9]+$/i.test(id || '')) return null;
  return path.join(TEMPLATES_DIR, `${id}.json`);
}
function readTemplate(id) {
  const p = templatePath(id);
  if (!p || !fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; }
}
function listTemplates() {
  try {
    return fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8').replace(/^﻿/, '')); } catch (_) { return null; } })
      .filter(Boolean)
      .sort((a, b) => (a.sku || '').localeCompare(b.sku || '', 'zh-CN') || (b.created || 0) - (a.created || 0));
  } catch (_) { return []; }
}

// 模版列表（可按 sku 过滤）
app.get('/api/templates', (req, res) => {
  const sku = req.query.sku ? String(req.query.sku) : '';
  let list = listTemplates();
  if (sku && sku !== '__all__') list = list.filter((t) => (t.sku || '') === sku);
  res.json(list);
});

// 保存模版
app.post('/api/templates', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const sku = String(b.sku || '').trim() || DEFAULT_SKU;
  const options = (b.options && typeof b.options === 'object') ? b.options : null;
  if (!name) return res.status(400).json({ error: '模版名称为空' });
  if (!options) return res.status(400).json({ error: '缺少设置内容' });
  const id = crypto.randomBytes(6).toString('hex');
  const obj = { id, name: name.slice(0, 60), sku, options, created: Date.now() };
  fs.writeFileSync(templatePath(id), JSON.stringify(obj));
  log(`★ 已保存混剪模版: ${obj.name} [${sku}]`);
  res.json({ ok: true, item: obj });
});

// 删除模版
app.delete('/api/templates/:id', (req, res) => {
  const p = templatePath(req.params.id);
  if (p && fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_) {} }
  res.json({ ok: true });
});

// 读取单条脚本全文
app.get('/api/scripts/:id', (req, res) => {
  const s = readScript(req.params.id);
  if (!s) return res.status(404).json({ error: '脚本不存在' });
  res.json(s);
});

// 新建脚本（粘贴文本或上传的 .txt 内容都走这里）
app.post('/api/scripts', (req, res) => {
  const content = String((req.body && req.body.content) || '');
  let title = String((req.body && req.body.title) || '').trim();
  if (!content.trim()) return res.status(400).json({ error: '脚本内容为空' });
  if (!title) title = content.replace(/\s+/g, ' ').trim().slice(0, 20) || '未命名脚本';
  const id = crypto.randomBytes(6).toString('hex');
  const sku = String((req.body && req.body.sku) || '').trim() || DEFAULT_SKU;
  const obj = { id, title: title.slice(0, 80), content, sku, created: Date.now() };
  fs.writeFileSync(scriptPath(id), JSON.stringify(obj));
  registerSku(sku);
  log(`★ 已保存脚本: ${obj.title} [${sku}]`);
  res.json({ ok: true, item: { id, title: obj.title, sku } });
});

// 一键生成脚本：结合脚本库 + 投放数据，融合出新草稿（不自动保存，返回供预览编辑）
app.post('/api/scripts/generate', async (req, res) => {
  if (!tiktok.configured()) return res.status(400).json({ error: '未配置 TikTok 凭证，无法读取投放数据' });
  try {
    const start = (req.query.start || '').slice(0, 10);
    const end = (req.query.end || '').slice(0, 10);
    log('🪄 一键生成脚本（融合投放数据）');
    const out = await generateFusedScript(start, end);
    res.json(out);
  } catch (e) {
    log('✗ 生成脚本失败:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 批量保存脚本（批量导入用）
app.post('/api/scripts/batch', (req, res) => {
  const arr = (req.body && req.body.scripts) || [];
  if (!Array.isArray(arr) || !arr.length) return res.status(400).json({ error: '没有可保存的脚本' });
  const batchSku = String((req.body && req.body.sku) || '').trim() || DEFAULT_SKU;
  const saved = [];
  for (const s of arr) {
    const content = String(s.content || '');
    if (!content.trim()) continue;
    let title = String(s.title || '').trim() || content.replace(/\s+/g, ' ').trim().slice(0, 20) || '未命名脚本';
    const sku = String(s.sku || '').trim() || batchSku; // 可按段指定，否则用整批 SKU
    const id = crypto.randomBytes(6).toString('hex');
    fs.writeFileSync(scriptPath(id), JSON.stringify({ id, title: title.slice(0, 80), content, sku, created: Date.now() }));
    registerSku(sku);
    saved.push({ id, title });
  }
  log(`★ 批量保存脚本 ${saved.length} 段 [${batchSku}]`);
  res.json({ ok: true, count: saved.length });
});

// 编辑脚本
app.put('/api/scripts/:id', (req, res) => {
  const s = readScript(req.params.id);
  if (!s) return res.status(404).json({ error: '脚本不存在' });
  if (req.body && typeof req.body.content === 'string') s.content = req.body.content;
  if (req.body && typeof req.body.title === 'string' && req.body.title.trim()) s.title = req.body.title.trim().slice(0, 80);
  if (req.body && typeof req.body.sku === 'string' && req.body.sku.trim()) { s.sku = req.body.sku.trim(); registerSku(s.sku); }
  fs.writeFileSync(scriptPath(s.id), JSON.stringify(s));
  res.json({ ok: true });
});

// 删除脚本
app.delete('/api/scripts/:id', (req, res) => {
  const p = scriptPath(req.params.id);
  if (p && fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_) {} }
  res.json({ ok: true });
});

// ---------- TikTok 投放数据 ----------
// 状态：是否已配置凭证 + 广告主信息 + 默认日期区间（不含 token）
app.get('/api/tiktok/status', async (req, res) => {
  if (!tiktok.configured()) return res.json({ configured: false });
  try {
    const info = await tiktok.getAdvertisers();
    res.json({ configured: true, ...info });
  } catch (e) {
    res.json({ configured: true, error: String(e.message || e) });
  }
});

// 按投放视频聚合的报表（带 5 分钟缓存，避免重复拉取）
const ttCache = new Map();
app.get('/api/tiktok/videos', async (req, res) => {
  if (!tiktok.configured()) return res.status(400).json({ error: '未配置 TikTok 凭证' });
  const start = (req.query.start || '').slice(0, 10);
  const end = (req.query.end || '').slice(0, 10);
  const key = `${start}|${end}`;
  const cached = ttCache.get(key);
  if (cached && Date.now() - cached.t < 5 * 60 * 1000) return res.json(cached.data);
  try {
    log(`📊 拉取 TikTok 投放数据 ${start || '默认'}~${end || '默认'}`);
    const data = await tiktok.getVideoReport(start, end);
    ttCache.set(key, { t: Date.now(), data });
    res.json(data);
  } catch (e) {
    log('✗ TikTok 数据拉取失败:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- 视频素材库（按文件夹分类，持久） ----------
const VIDEO_EXT = /\.(mp4|mov|mkv|avi|webm|flv|m4v|m4s)$/i;
function safeFolder(name) {
  return String(name || '默认').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/^\.+|\.+$/g, '').trim().slice(0, 40) || '默认';
}
function matFolderDir(folder) { return path.join(MATERIALS_DIR, safeFolder(folder)); }
function listMatFolders() {
  try {
    return fs.readdirSync(MATERIALS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== '_incoming')
      .map((d) => ({ name: d.name, count: (() => { try { return fs.readdirSync(path.join(MATERIALS_DIR, d.name)).filter((f) => VIDEO_EXT.test(f)).length; } catch (_) { return 0; } })() }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  } catch (_) { return []; }
}
function listMaterials(folder) {
  const dir = matFolderDir(folder);
  try {
    return fs.readdirSync(dir).filter((f) => f.includes('__') && VIDEO_EXT.test(f)).map((f) => ({
      id: f.slice(0, f.indexOf('__')), name: f.slice(f.indexOf('__') + 2), folder: safeFolder(folder),
    }));
  } catch (_) { return []; }
}
function findMaterial(folder, id) {
  if (!/^[a-z0-9]+$/i.test(id || '')) return null;
  try { const f = fs.readdirSync(matFolderDir(folder)).find((x) => x.startsWith(id + '__') && VIDEO_EXT.test(x)); return f ? path.join(matFolderDir(folder), f) : null; } catch (_) { return null; }
}
function matThumbPath(folder, id) { return path.join(matFolderDir(folder), id + '.jpg'); }
function genThumb(videoPath, thumbPath) {
  try {
    const p = spawn(FFMPEG, ['-y', '-ss', '0.5', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', thumbPath]);
    p.on('error', () => {});
  } catch (_) {}
}

const matUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) { const d = path.join(MATERIALS_DIR, '_incoming'); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename(req, file, cb) { cb(null, crypto.randomBytes(8).toString('hex')); },
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 200 },
}).array('videos', 200);

// 文件夹：列表 / 新建 / 删除
app.get('/api/materials/folders', (req, res) => res.json(listMatFolders()));
app.post('/api/materials/folder', (req, res) => {
  const name = safeFolder((req.body || {}).name);
  try { fs.mkdirSync(matFolderDir(name), { recursive: true }); res.json({ ok: true, name }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.delete('/api/materials/folder/:name', (req, res) => {
  const name = safeFolder(req.params.name);
  if (name === '默认') return res.status(400).json({ error: '默认文件夹不可删除' });
  try { fs.rmSync(matFolderDir(name), { recursive: true, force: true }); } catch (_) {}
  res.json({ ok: true });
});

// 素材：列表（folder=__all__ 看全部）/ 缩略图 / 预览 / 删除
app.get('/api/materials', (req, res) => {
  const folder = req.query.folder;
  if (!folder || folder === '__all__') {
    let all = [];
    for (const f of listMatFolders()) all = all.concat(listMaterials(f.name));
    return res.json(all);
  }
  res.json(listMaterials(folder));
});
app.get('/api/materials/thumb/:folder/:id', (req, res) => {
  const t = matThumbPath(req.params.folder, req.params.id);
  if (fs.existsSync(t)) return res.sendFile(t);
  res.status(404).end();
});
app.get('/api/materials/file/:folder/:id', (req, res) => {
  const f = findMaterial(req.params.folder, req.params.id);
  if (!f) return res.status(404).end();
  res.sendFile(f);
});
app.delete('/api/materials/:folder/:id', (req, res) => {
  const f = findMaterial(req.params.folder, req.params.id);
  if (f) { try { fs.unlinkSync(f); } catch (_) {} try { fs.unlinkSync(matThumbPath(req.params.folder, req.params.id)); } catch (_) {} }
  res.json({ ok: true });
});

// 文件夹重命名
app.post('/api/materials/folder/rename', (req, res) => {
  const oldName = safeFolder((req.body || {}).oldName);
  const newName = safeFolder((req.body || {}).newName);
  if (!newName) return res.status(400).json({ error: '新名称无效' });
  if (oldName === '默认') return res.status(400).json({ error: '默认文件夹不可改名' });
  if (oldName === newName) return res.json({ ok: true, name: newName });
  const oldDir = matFolderDir(oldName), newDir = matFolderDir(newName);
  if (!fs.existsSync(oldDir)) return res.status(404).json({ error: '文件夹不存在' });
  if (fs.existsSync(newDir)) return res.status(400).json({ error: '已存在同名文件夹' });
  try { fs.renameSync(oldDir, newDir); log(`📂 文件夹改名「${oldName}」→「${newName}」`); res.json({ ok: true, name: newName }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// 移动素材到另一个文件夹（拖拽用，支持批量）
app.post('/api/materials/move', (req, res) => {
  const { items, toFolder } = req.body || {};
  if (!Array.isArray(items) || !items.length || !toFolder) return res.status(400).json({ error: '参数缺失' });
  const to = safeFolder(toFolder);
  const toDir = matFolderDir(to); fs.mkdirSync(toDir, { recursive: true });
  let moved = 0;
  for (const it of items) {
    if (safeFolder(it.folder) === to) continue;
    const src = findMaterial(it.folder, it.id);
    if (!src) continue;
    try {
      fs.renameSync(src, path.join(toDir, path.basename(src)));
      const t1 = matThumbPath(it.folder, it.id), t2 = matThumbPath(to, it.id);
      if (fs.existsSync(t1)) { try { fs.renameSync(t1, t2); } catch (_) { try { fs.copyFileSync(t1, t2); fs.unlinkSync(t1); } catch (_) {} } }
      moved++;
    } catch (_) {}
  }
  log(`📂 移动素材 ${moved} 个 → 文件夹「${to}」`);
  res.json({ ok: true, moved });
});

// 上传视频到素材库（保存进指定文件夹 + 生成缩略图）
app.post('/api/materials/upload', (req, res) => {
  matUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: '上传失败：' + (err.message || err) });
    try {
      const folder = safeFolder((req.body || {}).folder);
      const dir = matFolderDir(folder); fs.mkdirSync(dir, { recursive: true });
      const saved = [];
      for (const file of (req.files || [])) {
        const id = crypto.randomBytes(6).toString('hex');
        const name = safeName(file.originalname);
        const dst = path.join(dir, `${id}__${name}`);
        try { fs.renameSync(file.path, dst); } catch (_) { fs.copyFileSync(file.path, dst); try { fs.unlinkSync(file.path); } catch (_) {} }
        genThumb(dst, matThumbPath(folder, id));
        saved.push({ id, name, folder });
      }
      log(`📁 素材入库 ${saved.length} 个 → 文件夹「${folder}」`);
      res.json({ ok: true, saved });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
});

// 列出所有广告户（供上传选择）
let ttAccountsCache = null;
app.get('/api/tiktok/accounts', async (req, res) => {
  if (!tiktok.configured()) return res.status(400).json({ error: '未配置 TikTok 凭证' });
  try {
    if (!ttAccountsCache || Date.now() - ttAccountsCache.t > 10 * 60 * 1000) {
      ttAccountsCache = { t: Date.now(), data: await tiktok.listAccounts() };
    }
    res.json(ttAccountsCache.data);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// 把某条成片上传到指定广告户
app.post('/api/tiktok/upload-video', async (req, res) => {
  if (!tiktok.configured()) return res.status(400).json({ error: '未配置 TikTok 凭证' });
  const { jobId, index, advertiserId } = req.body || {};
  if (!jobId || !advertiserId) return res.status(400).json({ error: '缺少 jobId 或 advertiserId' });
  const file = resultFile(jobId, index);
  if (!file) return res.status(404).json({ error: '成片文件不存在或已清理' });
  try {
    const name = exportName(jobId, Math.max(1, parseInt(index, 10) || 1));
    const r = await tiktok.uploadVideo(advertiserId, file, name);
    log(`⬆ 成片上传到 TikTok adv=${advertiserId} 「${name}」 → video_id=${r.video_id}`);
    res.json({ ok: true, ...r });
  } catch (e) {
    log('✗ 上传 TikTok 失败:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 一次上传到多个广告户
app.post('/api/tiktok/upload-video-multi', async (req, res) => {
  if (!tiktok.configured()) return res.status(400).json({ error: '未配置 TikTok 凭证' });
  const { jobId, index, advertiserIds } = req.body || {};
  if (!jobId || !Array.isArray(advertiserIds) || !advertiserIds.length) return res.status(400).json({ error: '缺少 jobId 或广告户' });
  const file = resultFile(jobId, index);
  if (!file) return res.status(404).json({ error: '成片文件不存在或已清理' });
  try {
    const name = exportName(jobId, Math.max(1, parseInt(index, 10) || 1));
    const results = await tiktok.uploadVideoMulti(advertiserIds, file, name);
    const okN = results.filter((r) => r.ok).length;
    log(`⬆ 成片「${name}」上传到 ${advertiserIds.length} 个广告户：成功 ${okN}/${advertiserIds.length}`);
    res.json({ ok: true, results });
  } catch (e) {
    log('✗ 多账户上传失败:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 批量上传：多条成片 × 多个广告户
app.post('/api/tiktok/upload-batch', async (req, res) => {
  if (!tiktok.configured()) return res.status(400).json({ error: '未配置 TikTok 凭证' });
  const { items, advertiserIds } = req.body || {};
  if (!Array.isArray(items) || !items.length || !Array.isArray(advertiserIds) || !advertiserIds.length) return res.status(400).json({ error: '缺少成片或广告户' });
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const n = Math.max(1, parseInt(it.index, 10) || 1);
    const file = resultFile(it.jobId, it.index);
    if (!file) { out.push({ name: exportName(it.jobId, n), ok: false, error: '文件不存在' }); continue; }
    const name = exportName(it.jobId, n);
    try { const results = await tiktok.uploadVideoMulti(advertiserIds, file, name); out.push({ name, ok: true, results }); }
    catch (e) { out.push({ name, ok: false, error: String(e.message || e) }); }
    if (i < items.length - 1) await new Promise((r) => setTimeout(r, 800)); // 条目间隔，避免限流
  }
  log(`⬆ 批量上传 ${items.length} 条 × ${advertiserIds.length} 户`);
  res.json({ ok: true, out });
});

// 上传选中成片到某账户，并写入「待建广告队列」（建广告由 Claude 用 skill 复核后执行）
app.post('/api/tiktok/queue-ads', async (req, res) => {
  if (!tiktok.configured()) return res.status(400).json({ error: '未配置 TikTok 凭证' });
  const { items, advertiserId } = req.body || {};
  if (!Array.isArray(items) || !items.length || !advertiserId) return res.status(400).json({ error: '缺少成片或广告户' });
  const queued = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const n = Math.max(1, parseInt(it.index, 10) || 1);
    const file = resultFile(it.jobId, it.index);
    if (!file) continue;
    const name = exportName(it.jobId, n);
    try { const r = await tiktok.uploadVideo(advertiserId, file, name); queued.push({ name, video_id: r.video_id, material_id: r.material_id, ok: true }); }
    catch (e) { queued.push({ name, ok: false, error: String(e.message || e) }); }
    if (i < items.length - 1) await new Promise((r) => setTimeout(r, 800));
  }
  // 追加到待建广告队列文件
  try {
    const qfile = path.join(DATA_DIR, 'pending_ads.json');
    let q = []; try { q = JSON.parse(fs.readFileSync(qfile, 'utf8')); } catch (_) {}
    q.push({ time: Date.now(), advertiserId, videos: queued.filter((v) => v.ok) });
    fs.writeFileSync(qfile, JSON.stringify(q, null, 2));
  } catch (e) { log('⚠ 写待建广告队列失败:', e); }
  const okN = queued.filter((v) => v.ok).length;
  log(`🚀 已上传并入队待建广告：${okN}/${queued.length} → adv=${advertiserId}`);
  res.json({ ok: true, queued, count: okN, advertiserId });
});

// 开始混剪
app.post('/api/mix', (req, res) => {
  const { jobId, options } = req.body || {};
  if (!jobId) return res.status(400).json({ error: '缺少 jobId' });
  const jobDir = path.join(UPLOAD_DIR, jobId);
  if (!fs.existsSync(jobDir)) return res.status(404).json({ error: '任务不存在或已过期' });

  jobs.set(jobId, { status: 'queued', stage: 'queued', percent: 0, message: '排队中…', clients: [] });
  const o = options || {};
  log(`▶ 开始混剪 job=${jobId} 参数=` + JSON.stringify({
    生成条数: Math.max(1, Math.min(5, Number(o.count) || 1)),
    画布: o.canvas, 帧率: o.fps, 时长基准: o.durationBasis, 顺序: o.order,
    每段秒数: o.clipSeconds, 混音: o.audioMode, 配音音量: o.voiceVolume, 音乐音量: o.bgmVolume, 字幕: !!o.subtitles,
  }));
  res.json({ ok: true, jobId });
  // 异步执行，不阻塞响应
  runMixJob(jobId, o);
});

// 进度（SSE）
app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  if (!job) {
    res.write(`data: ${JSON.stringify({ status: 'error', error: '任务不存在' })}\n\n`);
    return res.end();
  }
  job.clients.push(res);
  // 立即推送当前状态
  res.write(
    `data: ${JSON.stringify({
      status: job.status, stage: job.stage, percent: Math.round(job.percent || 0),
      message: job.message || '', error: job.error || null, ready: job.status === 'done',
      count: job.count || 1, done: (job.outputs || []).length,
    })}\n\n`
  );
  req.on('close', () => {
    job.clients = job.clients.filter((c) => c !== res);
  });
});

// 解析第 index 条成片的文件路径（index 从 1 开始；缺省取第 1 条）
function resultFile(jobId, index) {
  const n = Math.max(1, parseInt(index, 10) || 1);
  const indexed = path.join(OUTPUT_DIR, `${jobId}_${n}.mp4`);
  if (fs.existsSync(indexed)) return indexed;
  const legacy = path.join(OUTPUT_DIR, `${jobId}.mp4`); // 兼容旧的单条命名
  if (n === 1 && fs.existsSync(legacy)) return legacy;
  return null;
}

// 预览成片（支持多条：/api/result/:jobId 或 /api/result/:jobId/:index）
app.get('/api/result/:jobId/:index?', (req, res) => {
  const file = resultFile(req.params.jobId, req.params.index);
  if (!file) return res.status(404).send('成片尚未生成');
  res.sendFile(file);
});

// 下载成片（支持多条）
app.get('/api/download/:jobId/:index?', (req, res) => {
  const file = resultFile(req.params.jobId, req.params.index);
  if (!file) return res.status(404).send('成片尚未生成');
  const n = Math.max(1, parseInt(req.params.index, 10) || 1);
  res.download(file, exportName(req.params.jobId, n));
});

// 下载字幕文件（SRT）
app.get('/api/subtitle/:jobId', (req, res) => {
  const file = path.join(UPLOAD_DIR, req.params.jobId, 'sub.srt');
  if (!fs.existsSync(file)) return res.status(404).send('没有字幕文件');
  res.download(file, `字幕_${req.params.jobId}.srt`);
});

// 历史任务：列表（含每条成片是否还在）
app.get('/api/history', (req, res) => {
  const list = listHistory().map((h) => ({
    ...h,
    outputsExist: (h.outputs || []).map((name) => fs.existsSync(path.join(OUTPUT_DIR, name))),
  }));
  res.json(list);
});

// 历史任务：删除一条记录（可选连带删除成片文件）
app.delete('/api/history/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-z0-9]+$/i.test(id)) return res.status(400).json({ error: 'bad id' });
  const rec = (() => { try { return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, id + '.json'), 'utf8')); } catch (_) { return null; } })();
  try { fs.unlinkSync(path.join(HISTORY_DIR, id + '.json')); } catch (_) {}
  if (req.query.withFiles === '1' && rec) {
    for (const name of (rec.outputs || [])) { try { fs.unlinkSync(path.join(OUTPUT_DIR, name)); } catch (_) {} }
  }
  res.json({ ok: true });
});

// 查看运行日志（最近 500 行）
app.get('/api/logs', (req, res) => {
  try {
    const txt = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
    const lines = txt.split('\n');
    res.type('text/plain').send(lines.slice(-500).join('\n'));
  } catch (e) {
    res.status(500).send('读取日志失败：' + e.message);
  }
});

// ---------- 一键生成并上传（按产品 SKU 选资源 → 逐配音生成 → 上传广告户）----------
const ocJobs = new Map();
let ocRunning = false; // 单任务锁：同一时间只允许一个一键生成在跑，防止并发抢资源
function ocSet(oc, patch) {
  Object.assign(oc, patch);
  const payload = JSON.stringify({
    status: oc.status, stage: oc.stage, percent: Math.round(oc.percent || 0),
    message: oc.message || '', error: oc.error || null, done: oc.status === 'done',
    generated: oc.generated || 0, uploaded: oc.uploaded || 0, total: oc.total || 0,
    results: oc.results || [],
  });
  for (const res of oc.clients) { try { res.write(`data: ${payload}\n\n`); } catch (_) {} }
}
function resolveFolderName(folders, sku) {
  const s = String(sku || '').trim().toLowerCase();
  const hit = folders.find((f) => f.name.toLowerCase() === s) || folders.find((f) => f.name === sku);
  return hit ? hit.name : null;
}

// 可用 SKU：各资源库文件夹的并集 + 视频/配音/背景音乐数量
app.get('/api/oneclick/skus', (req, res) => {
  const map = new Map(); // lowercase -> {sku, videos, voices, bgm}
  const add = (name, key, count) => {
    const lc = name.toLowerCase();
    if (!map.has(lc)) map.set(lc, { sku: name, videos: 0, voices: 0, bgm: 0 });
    map.get(lc)[key] = count;
    if (/[A-Z]/.test(name)) map.get(lc).sku = name; // 偏好带大写的展示名
  };
  for (const f of listMatFolders()) add(f.name, 'videos', f.count);
  for (const f of listAudioFolders('voice')) add(f.name, 'voices', f.count);
  for (const f of listAudioFolders('bgm')) add(f.name, 'bgm', f.count);
  // 只返回能生成的 SKU（既有视频又有配音）
  res.json([...map.values()].filter((s) => s.videos > 0 && s.voices > 0).sort((a, b) => a.sku.localeCompare(b.sku, 'zh-CN')));
});

// 启动一键生成
app.post('/api/oneclick', (req, res) => {
  const b = req.body || {};
  const sku = String(b.sku || '').trim();
  const advertiserId = String(b.advertiserId || '').trim();
  const totalCount = Math.max(1, Math.min(60, Number(b.totalCount) || 12)); // 总共要生成多少条
  const maxVoices = Number(b.maxVoices) > 0 ? Math.floor(Number(b.maxVoices)) : 0; // 0=全部；可限制只用前 N 条配音
  const subtitles = !!b.subtitles;
  const batch = String(b.batch || '').trim();
  const doUpload = b.upload !== false;
  // 混剪模版：选了就用模版的画面/帧率/截取/混音/音量等设置；没选用默认
  const defaultMix = { canvas: 'vertical', fps: 60, order: 'shuffle', clipSeconds: 3, audioMode: 'duck', voiceVolume: 1.0, bgmVolume: 0.22 };
  let baseMix = { ...defaultMix };
  const templateId = String(b.templateId || '').trim();
  if (templateId) { const t = readTemplate(templateId); if (t && t.options) baseMix = { ...defaultMix, ...t.options }; }
  if (!sku) return res.status(400).json({ error: '请选择产品 SKU' });
  if (doUpload) {
    if (!tiktok.configured()) return res.status(400).json({ error: '未配置 TikTok 凭证' });
    if (!advertiserId) return res.status(400).json({ error: '请选择广告账户' });
  }
  const matFolder = resolveFolderName(listMatFolders(), sku);
  const voiceFolder = resolveFolderName(listAudioFolders('voice'), sku);
  const bgmFolder = resolveFolderName(listAudioFolders('bgm'), sku);
  const mats = matFolder ? listMaterials(matFolder) : [];
  const voices = voiceFolder ? listAudio('voice', voiceFolder) : [];
  const bgms = bgmFolder ? listAudio('bgm', bgmFolder) : [];
  if (!mats.length) return res.status(400).json({ error: `SKU「${sku}」下没有视频素材` });
  if (!voices.length) return res.status(400).json({ error: `SKU「${sku}」下没有配音` });
  if (!bgms.length) return res.status(400).json({ error: `SKU「${sku}」下没有背景音乐` });

  // 单任务锁：已有任务在跑就拒绝，避免并发（多次点按钮 / 多端触发）
  if (ocRunning) return res.status(409).json({ error: '已有一键生成任务正在进行中，请等它跑完再试。' });
  ocRunning = true;

  const ocId = crypto.randomBytes(6).toString('hex');
  ocJobs.set(ocId, { status: 'queued', stage: 'queued', percent: 0, message: '排队中…', clients: [], results: [], generated: 0, uploaded: 0, total: totalCount });
  log(`🚀 一键生成启动 SKU=${sku} 视频=${mats.length} 配音=${voices.length} 共${totalCount}条 模版=${templateId || '默认'} 上传=${doUpload ? advertiserId : '否'}`);
  res.json({ ok: true, ocId });
  runOneClick(ocId, { sku, advertiserId, totalCount, maxVoices, subtitles, batch, doUpload, matFolder, voiceFolder, bgmFolder, baseMix }).catch((e) => {
    const oc = ocJobs.get(ocId); if (oc) ocSet(oc, { status: 'error', error: String(e.message || e), message: '出错了' });
  }).finally(() => { ocRunning = false; }); // 跑完(成功/失败)释放锁
});

// 一键生成进度（SSE）
app.get('/api/oneclick/progress/:ocId', (req, res) => {
  const oc = ocJobs.get(req.params.ocId);
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders?.();
  if (!oc) { res.write(`data: ${JSON.stringify({ status: 'error', error: '任务不存在' })}\n\n`); return res.end(); }
  oc.clients.push(res);
  ocSet(oc, {}); // 立即推送当前态
  req.on('close', () => { oc.clients = oc.clients.filter((c) => c !== res); });
});

async function runOneClick(ocId, p) {
  const oc = ocJobs.get(ocId);
  const t0 = Date.now();
  const mats = listMaterials(p.matFolder);
  const voices = listAudio('voice', p.voiceFolder);
  const firstBgm = listAudio('bgm', p.bgmFolder)[0];
  const bgmPathSrc = firstBgm ? findAudio('bgm', p.bgmFolder, firstBgm.id) : null;

  // 过滤太短的配音（<5 秒，通常是坏文件）
  ocSet(oc, { status: 'running', stage: 'probe', percent: 1, message: '正在检查配音…' });
  const goodVoices = [];
  for (const v of voices) {
    const vp = findAudio('voice', p.voiceFolder, v.id);
    if (!vp) continue;
    let dur = 0; try { dur = await probeDuration(vp); } catch (_) {}
    if (dur >= 5) goodVoices.push({ name: v.name, path: vp });
    else log(`⏭ 一键生成跳过过短配音 ${v.name} (${dur}s)`);
  }
  if (!goodVoices.length) throw new Error('没有有效配音（都太短，<5 秒）');
  if (p.maxVoices > 0 && goodVoices.length > p.maxVoices) goodVoices.length = p.maxVoices; // 试跑：只用前 N 条配音
  const V = goodVoices.length;
  const total = p.totalCount;
  // 把总条数按轮询均分到各配音：前 (total%V) 条配音各多 1 条；total<V 时只用前 total 条配音（最大化配音多样性）
  const shares = goodVoices.map((_, j) => Math.floor(total / V) + (j < (total % V) ? 1 : 0));
  const used = shares.filter((x) => x > 0).length;
  oc.total = total;

  const items = []; // {jobId,index,file,name}
  const genSpan = p.doUpload ? 70 : 98;
  let ui = 0;

  for (let vi = 0; vi < goodVoices.length; vi++) {
    const share = shares[vi];
    if (share <= 0) continue;
    const v = goodVoices[vi];
    const jobId = crypto.randomBytes(6).toString('hex');
    const jobDir = path.join(UPLOAD_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    let si = 0;
    for (const m of mats) {
      const src = findMaterial(p.matFolder, m.id);
      if (src) { const seq = String(++si).padStart(4, '0'); fs.copyFileSync(src, path.join(jobDir, `vid__lib${seq}__` + path.basename(src).replace(/^[a-z0-9]+__/i, ''))); }
    }
    fs.copyFileSync(v.path, path.join(jobDir, 'voice__' + path.basename(v.path)));
    if (bgmPathSrc) fs.copyFileSync(bgmPathSrc, path.join(jobDir, 'bgm__' + path.basename(bgmPathSrc)));

    const opts = {
      ...p.baseMix,            // 来自模版（或默认）：画面/帧率/顺序/截取秒数/混音/音量
      durationBasis: 'voice',  // 一键生成固定以配音时长为准（逐配音出片）
      count: share,            // 本条配音分到的条数
      subtitles: p.subtitles,  // 由「生成字幕」勾选决定
      sku: p.sku, batch: p.batch,
    };
    jobs.set(jobId, { status: 'queued', stage: 'queued', percent: 0, message: '', clients: [] });
    ocSet(oc, { stage: 'generate', percent: 1 + (ui / used) * genSpan, message: `生成中：配音 ${ui + 1}/${used}「${v.name}」× ${share}` });
    await runMixJob(jobId, opts);
    const job = jobs.get(jobId);
    if (job && job.status === 'error') { log(`✗ 一键生成某条失败 ${v.name}: ${job.error}`); ui++; continue; }
    const outs = (job && job.outputs) || [];
    for (let i = 0; i < outs.length; i++) items.push({ jobId, index: i + 1, file: outs[i], name: exportName(jobId, i + 1) });
    ui++;
    oc.generated = items.length;
    ocSet(oc, { percent: 1 + (ui / used) * genSpan, message: `已生成 ${items.length}/${total} 条` });
  }

  if (p.doUpload && items.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      ocSet(oc, { stage: 'upload', percent: 71 + (i / items.length) * 28, message: `上传中 ${i + 1}/${items.length}：${it.name}` });
      try { const r = await tiktok.uploadVideo(p.advertiserId, it.file, it.name); oc.results.push({ name: it.name, ok: true, video_id: r.video_id }); }
      catch (e) { oc.results.push({ name: it.name, ok: false, error: String(e.message || e) }); }
      oc.uploaded = oc.results.filter((r) => r.ok).length;
      if (i < items.length - 1) await new Promise((r) => setTimeout(r, 800));
    }
  } else if (!p.doUpload) {
    for (const it of items) oc.results.push({ name: it.name, ok: true, video_id: '(未上传)' });
  }

  const okN = oc.results.filter((r) => r.ok).length;
  ocSet(oc, {
    status: 'done', stage: 'done', percent: 100, generated: items.length, uploaded: p.doUpload ? okN : 0,
    message: p.doUpload ? `完成：生成 ${items.length} 条，上传成功 ${okN}/${items.length} 条` : `完成：生成 ${items.length} 条（未上传）`,
  });
  log(`🚀 一键生成完成 SKU=${p.sku} 生成${items.length} 上传${p.doUpload ? okN : '跳过'} 用时${Math.round((Date.now() - t0) / 1000)}s`);
}

const server = app.listen(PORT, () => {
  const hasWhisper = fs.existsSync(WHISPER) && fs.existsSync(WHISPER_MODEL);
  console.log(`\n  混剪工具已启动 →  http://localhost:${PORT}\n`);
  console.log(`  你的素材库/脚本库数据保存在： ${DATA_DIR}  （升级不会丢失）\n`);
  log('====================================================');
  log(`🚀 服务启动 端口=${PORT} 字幕引擎=${hasWhisper ? '可用(whisper base)' : '不可用'} 数据目录=${DATA_DIR} 日志=${LOG_FILE}`);
});

// 端口被占用时友好提示（通常是已经启动了一个，直接用即可）
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n  端口 ${PORT} 已被占用 —— 混剪工具很可能已经在运行了。`);
    console.log(`  请直接在浏览器打开： http://localhost:${PORT}\n`);
    log(`⚠ 端口 ${PORT} 已被占用，本次不重复启动。`);
    process.exit(0);
  } else {
    log('‼ 服务启动失败:', e);
    console.log('  启动失败：' + e.message);
    process.exit(1);
  }
});
