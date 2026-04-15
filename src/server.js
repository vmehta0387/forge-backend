const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs/promises');
const { spawnSync } = require('child_process');

const { normalizeScenePayload } = require('./validateScene');
const { runBlenderExport } = require('./blenderRunner');

const app = express();
const port = Number(process.env.PORT || 10000);

app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((v) => v.trim()) : true,
  })
);
app.use(express.json({ limit: '5mb' }));

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

app.post('/api/clean-export', async (req, res) => {
  const startedAt = Date.now();
  const jobId = crypto.randomUUID();
  const timeoutMs = Number(process.env.EXPORT_TIMEOUT_MS || 6 * 60 * 1000);
  const assetRoot = process.env.ASSET_ROOT || path.resolve(process.cwd(), 'assets');

  let tempDir = '';

  try {
    const sourceScene = req.body?.scene ?? req.body?.config;
    const scene = normalizeScenePayload(sourceScene);

    if (!scene.hexGrid.length) {
      return res.status(400).json({ error: 'Scene has no hex grid cells.' });
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge3d-clean-export-'));
    const scenePath = path.join(tempDir, 'scene.json');
    const outputPath = path.join(tempDir, 'clean-export.stl');

    await fs.writeFile(scenePath, JSON.stringify(scene), 'utf8');
    await runBlenderExport({
      jobId,
      scenePath,
      outputPath,
      assetRoot,
      timeoutMs,
    });

    const stl = await fs.readFile(outputPath);
    const elapsedMs = Date.now() - startedAt;
    const filename = typeof req.body?.filename === 'string' && req.body.filename.trim()
      ? req.body.filename.trim()
      : 'forge3d-clean-export.stl';

    res.setHeader('Content-Type', 'model/stl');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Job-Id', jobId);
    res.setHeader('X-Export-Duration-Ms', String(elapsedMs));
    res.status(200).send(stl);
  } catch (error) {
    console.error('[clean-export] failed', error);
    res.status(500).json({
      error: (error && error.message) || 'Failed to generate clean STL.',
      jobId,
    });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

app.listen(port, () => {
  console.log(`forge3d-clean-export listening on :${port}`);
});
