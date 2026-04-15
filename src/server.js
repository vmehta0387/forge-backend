const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs/promises');
const fss = require('fs');
const { spawnSync } = require('child_process');

const { normalizeScenePayload } = require('./validateScene');
const { runBlenderExport, runBlenderFastClean } = require('./blenderRunner');

const app = express();
const port = Number(process.env.PORT || 10000);
const maxParallelExports = Math.max(1, Number(process.env.MAX_PARALLEL_EXPORTS || 1));
const maxParallelQueuedExports = Math.max(
  1,
  Number(process.env.MAX_PARALLEL_QUEUED_EXPORTS || 1)
);
const maxQueuedJobs = Math.max(1, Number(process.env.MAX_QUEUED_JOBS || 100));
const maxStoredJobs = Math.max(maxQueuedJobs, Number(process.env.MAX_STORED_JOBS || 400));
const jobRetentionMs = Math.max(5 * 60 * 1000, Number(process.env.JOB_RETENTION_MS || 24 * 60 * 60 * 1000));

let activeExports = 0;
let activeQueuedWorkers = 0;

const queuedJobs = new Map();
const queueOrder = [];
const queuePending = [];

app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((v) => v.trim()) : true,
  })
);
app.use(express.json({ limit: '5mb' }));
const rawStlParser = express.raw({
  type: ['model/stl', 'application/sla', 'application/octet-stream'],
  limit: '120mb',
});

function safeFilename(name, fallback = 'forge3d-clean-export.stl') {
  if (typeof name !== 'string' || !name.trim()) return fallback;
  const trimmed = name.trim();
  const cleaned = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.toLowerCase().endsWith('.stl') ? cleaned : `${cleaned}.stl`;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email.toLowerCase();
}

function isPendingStatus(status) {
  return status === 'queued' || status === 'processing';
}

function toPublicJob(job) {
  const queuePosition = job.status === 'queued' ? Math.max(1, queuePending.indexOf(job.id) + 1) : 0;
  return {
    id: job.id,
    mode: job.mode,
    status: job.status,
    filename: job.filename,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    durationMs: job.durationMs || null,
    error: job.error || null,
    exportMode: job.exportMode || null,
    outputSizeBytes: job.outputSizeBytes || null,
    queuePosition,
    downloadReady: job.status === 'completed',
  };
}

async function removeJobFiles(job) {
  if (!job?.tempDir) return;
  await fs.rm(job.tempDir, { recursive: true, force: true }).catch(() => {});
}

function removeFromArray(array, value) {
  const idx = array.indexOf(value);
  if (idx >= 0) array.splice(idx, 1);
}

async function evictJob(jobId) {
  const job = queuedJobs.get(jobId);
  if (!job) return;
  removeFromArray(queueOrder, jobId);
  removeFromArray(queuePending, jobId);
  queuedJobs.delete(jobId);
  await removeJobFiles(job);
}

async function pruneFinishedJobs() {
  if (queueOrder.length <= maxStoredJobs) {
    return;
  }

  const now = Date.now();
  for (const jobId of [...queueOrder]) {
    if (queueOrder.length <= maxStoredJobs) break;
    const job = queuedJobs.get(jobId);
    if (!job || isPendingStatus(job.status)) continue;

    const completedAtMs = job.completedAt ? Date.parse(job.completedAt) : now;
    if (Number.isFinite(completedAtMs) && now - completedAtMs < jobRetentionMs) continue;

    await evictJob(jobId);
  }
}

async function notifyJobResult(job) {
  const webhookUrl = process.env.JOB_NOTIFY_WEBHOOK_URL;
  if (!webhookUrl || !job.notifyEmail) return;

  const payload = {
    event: 'export_job_completed',
    job: toPublicJob(job),
    notifyEmail: job.notifyEmail,
    downloadUrl: `/api/clean-export/jobs/${job.id}/download`,
  };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.warn(`[clean-export:${job.id}] notification webhook failed`, error?.message || error);
  }
}

async function runRobustExportWithFallback({
  jobId,
  scenePath,
  outputPath,
  assetRoot,
  timeoutMs,
  exportMode,
  allowLiteFallback,
}) {
  let effectiveMode = exportMode;
  let blenderRun = null;

  const runExport = async (mode) => {
    await fs.rm(outputPath, { force: true }).catch(() => {});
    return runBlenderExport({
      jobId,
      scenePath,
      outputPath,
      assetRoot,
      timeoutMs,
      mode,
    });
  };

  try {
    blenderRun = await runExport(effectiveMode);
  } catch (error) {
    const signal = error?.signal;
    const shouldTryLite =
      allowLiteFallback &&
      effectiveMode !== 'lite' &&
      (signal === 'SIGKILL' ||
        signal === 'SIGTERM' ||
        /out of memory|terminated by signal/i.test(String(error?.message || '')));

    if (!shouldTryLite) {
      throw error;
    }

    console.warn(`[clean-export:${jobId}] retrying in lite mode after failure in ${effectiveMode} mode`);
    effectiveMode = 'lite';
    blenderRun = await runExport('lite');
  }

  try {
    await fs.access(outputPath);
  } catch {
    throw new Error(
      'Blender finished but did not produce STL output file.\n' +
        `${blenderRun?.stderr || blenderRun?.stdout || 'No Blender logs captured.'}`
    );
  }

  const stat = await fs.stat(outputPath);
  return { blenderRun, effectiveMode, outputStat: stat };
}

function parseLimit(value, fallback = 30, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function getPendingJobsCount() {
  let count = 0;
  queuedJobs.forEach((job) => {
    if (isPendingStatus(job.status)) count += 1;
  });
  return count;
}

function scheduleQueueWork() {
  setImmediate(() => {
    processQueue().catch((error) => {
      console.error('[clean-export] queue worker failure', error);
    });
  });
}

async function runQueuedJob(job) {
  const startedAt = Date.now();
  const timeoutMs = Number(process.env.EXPORT_TIMEOUT_MS || 6 * 60 * 1000);
  const assetRoot = process.env.ASSET_ROOT || path.resolve(process.cwd(), 'assets');
  const exportMode = process.env.EXPORT_MODE || 'robust';
  const allowLiteFallback = process.env.ALLOW_LITE_FALLBACK !== '0';

  job.status = 'processing';
  job.startedAt = new Date().toISOString();
  job.error = null;

  try {
    const result = await runRobustExportWithFallback({
      jobId: job.id,
      scenePath: job.scenePath,
      outputPath: job.outputPath,
      assetRoot,
      timeoutMs,
      exportMode,
      allowLiteFallback,
    });

    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.durationMs = Date.now() - startedAt;
    job.exportMode = result.effectiveMode;
    job.outputSizeBytes = result.outputStat.size;
    await notifyJobResult(job);
  } catch (error) {
    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.durationMs = Date.now() - startedAt;
    job.error = (error && error.message) || 'Failed to generate clean STL.';
    console.error(`[clean-export:${job.id}] queued export failed`, error);
  } finally {
    await pruneFinishedJobs();
  }
}

async function processQueue() {
  while (
    activeQueuedWorkers < maxParallelQueuedExports &&
    activeExports < maxParallelExports &&
    queuePending.length > 0
  ) {
    const jobId = queuePending.shift();
    const job = queuedJobs.get(jobId);
    if (!job || job.status !== 'queued') {
      continue;
    }

    activeQueuedWorkers += 1;
    activeExports += 1;

    runQueuedJob(job)
      .catch((error) => {
        console.error(`[clean-export:${jobId}] queued run crashed`, error);
      })
      .finally(() => {
        if (activeQueuedWorkers > 0) activeQueuedWorkers -= 1;
        if (activeExports > 0) activeExports -= 1;
        scheduleQueueWork();
      });
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'forge3d-clean-export',
    timestamp: new Date().toISOString(),
    queue: {
      pending: getPendingJobsCount(),
      activeWorkers: activeQueuedWorkers,
      maxQueuedWorkers: maxParallelQueuedExports,
      activeExports,
      maxParallelExports,
    },
  });
});

app.get('/health/deps', async (_req, res) => {
  const assetRoot = process.env.ASSET_ROOT || path.resolve(process.cwd(), 'assets');
  const blenderBin = process.env.BLENDER_BIN || 'blender';
  const requiredFiles = [
    path.join(assetRoot, 'terrain', 'Base Tiles_v1.stl'),
    path.join(assetRoot, 'objects', 'Single Assets_v1.stl'),
    path.join(assetRoot, 'objects', 'Single Assets_v2.stl'),
    path.join(assetRoot, 'objects', 'Single Assets_v3.stl'),
    path.join(assetRoot, 'objects', 'Single Assets_v4.stl'),
  ];

  const fileChecks = await Promise.all(
    requiredFiles.map(async (filePath) => {
      try {
        await fs.access(filePath);
        return { path: filePath, ok: true };
      } catch {
        return { path: filePath, ok: false };
      }
    })
  );

  const blenderVersion = spawnSync(blenderBin, ['--version'], {
    encoding: 'utf8',
    timeout: 15000,
  });

  const blenderOk = blenderVersion.status === 0;
  const missingAssets = fileChecks.filter((entry) => !entry.ok).map((entry) => entry.path);

  const response = {
    ok: blenderOk && missingAssets.length === 0,
    blender: {
      bin: blenderBin,
      ok: blenderOk,
      code: blenderVersion.status,
      stdout: (blenderVersion.stdout || '').split('\n').slice(0, 2).join('\n'),
      stderr: blenderVersion.stderr || '',
    },
    assets: {
      root: assetRoot,
      ok: missingAssets.length === 0,
      missing: missingAssets,
      checks: fileChecks,
    },
  };

  res.status(response.ok ? 200 : 500).json(response);
});

app.get('/api/clean-export/jobs', (req, res) => {
  const idsRaw = typeof req.query?.ids === 'string' ? req.query.ids.trim() : '';
  const limit = parseLimit(req.query?.limit, 30, 200);

  let jobs = [];
  if (idsRaw) {
    const ids = idsRaw
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    jobs = ids.map((id) => queuedJobs.get(id)).filter(Boolean);
  } else {
    jobs = [...queueOrder].reverse().slice(0, limit).map((id) => queuedJobs.get(id)).filter(Boolean);
  }

  res.json({
    jobs: jobs.map(toPublicJob),
    queue: {
      pending: getPendingJobsCount(),
      activeWorkers: activeQueuedWorkers,
      maxQueuedWorkers: maxParallelQueuedExports,
    },
  });
});

app.get('/api/clean-export/jobs/:jobId', (req, res) => {
  const job = queuedJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }
  res.json({ job: toPublicJob(job) });
});

app.delete('/api/clean-export/jobs/:jobId', async (req, res) => {
  const job = queuedJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  if (job.status === 'processing') {
    return res.status(409).json({ error: 'Job is processing and cannot be removed yet.' });
  }

  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();
  }

  await evictJob(job.id);
  return res.json({ ok: true });
});

app.get('/api/clean-export/jobs/:jobId/download', async (req, res) => {
  const job = queuedJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }
  if (job.status !== 'completed') {
    return res.status(409).json({
      error: 'Job is not completed yet.',
      status: job.status,
    });
  }

  try {
    const stat = await fs.stat(job.outputPath);
    const filename = safeFilename(job.filename, 'forge3d-clean-export.stl');
    res.setHeader('Content-Type', 'model/stl');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(stat.size));
    res.status(200);

    await new Promise((resolve, reject) => {
      const stream = fss.createReadStream(job.outputPath);
      stream.on('error', reject);
      res.on('error', reject);
      res.on('close', resolve);
      stream.pipe(res);
    });
  } catch (error) {
    return res.status(410).json({
      error: 'Export artifact is no longer available. Please run export again.',
      detail: error?.message || String(error),
    });
  }
});

app.post('/api/clean-export/jobs', async (req, res) => {
  const sourceScene = req.body?.scene ?? req.body?.config;
  const filename = safeFilename(req.body?.filename, 'forge3d-full-repair-export.stl');
  const notifyEmail = normalizeEmail(req.body?.notifyEmail);
  const pendingCount = getPendingJobsCount();

  if (pendingCount >= maxQueuedJobs) {
    return res.status(429).json({
      error: 'Full repair queue is full. Please retry shortly.',
      pendingCount,
      maxQueuedJobs,
    });
  }

  let tempDir = '';
  try {
    const scene = normalizeScenePayload(sourceScene);
    if (!scene.hexGrid.length) {
      return res.status(400).json({ error: 'Scene has no hex grid cells.' });
    }

    const jobId = crypto.randomUUID();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge3d-queued-clean-export-'));
    const scenePath = path.join(tempDir, 'scene.json');
    const outputPath = path.join(tempDir, 'clean-export.stl');
    await fs.writeFile(scenePath, JSON.stringify(scene), 'utf8');

    const job = {
      id: jobId,
      mode: 'full_repair',
      status: 'queued',
      filename,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      durationMs: null,
      error: null,
      exportMode: null,
      outputSizeBytes: null,
      notifyEmail,
      tempDir,
      scenePath,
      outputPath,
    };

    queuedJobs.set(jobId, job);
    queueOrder.push(jobId);
    queuePending.push(jobId);
    await pruneFinishedJobs();
    scheduleQueueWork();

    return res.status(202).json({
      job: toPublicJob(job),
      message: 'Full repair export queued successfully.',
    });
  } catch (error) {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    return res.status(400).json({
      error: error?.message || 'Invalid queue request payload.',
    });
  }
});

app.post('/api/clean-export-stl', rawStlParser, async (req, res) => {
  const startedAt = Date.now();
  const jobId = crypto.randomUUID();
  const timeoutMs = Number(process.env.FAST_EXPORT_TIMEOUT_MS || 2 * 60 * 1000);
  const decimateRatio = Number(process.env.FAST_DECIMATE_RATIO || 0.88);

  let tempDir = '';

  try {
    if (activeExports >= maxParallelExports) {
      res.setHeader('Retry-After', '5');
      return res.status(429).json({
        error: 'Exporter is busy. Please retry in a few seconds.',
        activeExports,
        maxParallelExports,
      });
    }
    activeExports += 1;

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({
        error: 'Request body must be a binary STL payload.',
      });
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge3d-fast-clean-export-'));
    const inputPath = path.join(tempDir, 'input.stl');
    const outputPath = path.join(tempDir, 'output.stl');

    await fs.writeFile(inputPath, req.body);
    const blenderRun = await runBlenderFastClean({
      jobId,
      inputPath,
      outputPath,
      decimateRatio,
      timeoutMs,
    });

    try {
      await fs.access(outputPath);
    } catch {
      throw new Error(
        'Fast Blender clean finished but did not produce STL output.\n' +
          `${blenderRun?.stderr || blenderRun?.stdout || 'No Blender logs captured.'}`
      );
    }

    const stat = await fs.stat(outputPath);
    const elapsedMs = Date.now() - startedAt;
    const filename = safeFilename(req.query?.filename, 'forge3d-clean-export.stl');

    res.setHeader('Content-Type', 'model/stl');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('X-Export-Job-Id', jobId);
    res.setHeader('X-Export-Duration-Ms', String(elapsedMs));
    res.setHeader('X-Export-Mode', 'fast');
    res.status(200);

    await new Promise((resolve, reject) => {
      const stream = fss.createReadStream(outputPath);
      stream.on('error', reject);
      res.on('error', reject);
      res.on('close', resolve);
      stream.pipe(res);
    });
  } catch (error) {
    console.error('[fast-clean-export] failed', error);
    res.status(500).json({
      error: (error && error.message) || 'Failed to generate clean STL.',
      jobId,
    });
  } finally {
    if (activeExports > 0) {
      activeExports -= 1;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    scheduleQueueWork();
  }
});

app.post('/api/clean-export', async (req, res) => {
  const startedAt = Date.now();
  const jobId = crypto.randomUUID();
  const timeoutMs = Number(process.env.EXPORT_TIMEOUT_MS || 6 * 60 * 1000);
  const assetRoot = process.env.ASSET_ROOT || path.resolve(process.cwd(), 'assets');
  const exportMode = process.env.EXPORT_MODE || 'robust';
  const allowLiteFallback = process.env.ALLOW_LITE_FALLBACK !== '0';

  let tempDir = '';

  try {
    if (activeExports >= maxParallelExports) {
      res.setHeader('Retry-After', '8');
      return res.status(429).json({
        error: 'Exporter is busy. Please retry in a few seconds.',
        activeExports,
        maxParallelExports,
      });
    }
    activeExports += 1;

    const sourceScene = req.body?.scene ?? req.body?.config;
    const scene = normalizeScenePayload(sourceScene);

    if (!scene.hexGrid.length) {
      return res.status(400).json({ error: 'Scene has no hex grid cells.' });
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge3d-clean-export-'));
    const scenePath = path.join(tempDir, 'scene.json');
    const outputPath = path.join(tempDir, 'clean-export.stl');
    await fs.writeFile(scenePath, JSON.stringify(scene), 'utf8');

    const result = await runRobustExportWithFallback({
      jobId,
      scenePath,
      outputPath,
      assetRoot,
      timeoutMs,
      exportMode,
      allowLiteFallback,
    });

    const elapsedMs = Date.now() - startedAt;
    const filename = safeFilename(req.body?.filename, 'forge3d-clean-export.stl');

    res.setHeader('Content-Type', 'model/stl');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(result.outputStat.size));
    res.setHeader('X-Export-Job-Id', jobId);
    res.setHeader('X-Export-Duration-Ms', String(elapsedMs));
    res.setHeader('X-Export-Mode', result.effectiveMode);
    res.status(200);

    await new Promise((resolve, reject) => {
      const stream = fss.createReadStream(outputPath);
      stream.on('error', reject);
      res.on('error', reject);
      res.on('close', resolve);
      stream.pipe(res);
    });
  } catch (error) {
    console.error('[clean-export] failed', error);
    res.status(500).json({
      error: (error && error.message) || 'Failed to generate clean STL.',
      jobId,
    });
  } finally {
    if (activeExports > 0) {
      activeExports -= 1;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    scheduleQueueWork();
  }
});

app.listen(port, () => {
  console.log(`forge3d-clean-export listening on :${port}`);
});
