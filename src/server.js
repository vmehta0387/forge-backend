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
let activeExports = 0;

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

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'forge3d-clean-export', timestamp: new Date().toISOString() });
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
    let blenderRun = null;
    let effectiveMode = exportMode;

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
        (signal === 'SIGKILL' || signal === 'SIGTERM' || /out of memory|terminated by signal/i.test(String(error?.message || '')));

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
    const elapsedMs = Date.now() - startedAt;
    const filename = safeFilename(req.body?.filename, 'forge3d-clean-export.stl');

    res.setHeader('Content-Type', 'model/stl');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('X-Export-Job-Id', jobId);
    res.setHeader('X-Export-Duration-Ms', String(elapsedMs));
    res.setHeader('X-Export-Mode', effectiveMode);
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
  }
});

app.listen(port, () => {
  console.log(`forge3d-clean-export listening on :${port}`);
});
