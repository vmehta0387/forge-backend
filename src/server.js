const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs/promises');
const fss = require('fs');
const { spawnSync } = require('child_process');

const { runTrimeshClean, runColor3mfExport } = require('./pythonRunner');

const app = express();
const port = Number(process.env.PORT || 10000);
const maxParallelExports = Math.max(1, Number(process.env.MAX_PARALLEL_EXPORTS || 1));
const trimeshTimeoutMs = Math.max(5000, Number(process.env.TRIMESH_CLEAN_TIMEOUT_MS || 2 * 60 * 1000));

let activeExports = 0;

app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((v) => v.trim()) : true,
  })
);
app.use(express.json({ limit: '8mb' }));

const rawStlParser = express.raw({
  type: ['model/stl', 'application/sla', 'application/octet-stream'],
  limit: '120mb',
});

function safeFilename(name, fallback = 'forge3d-clean-export.stl', extension = '.stl') {
  if (typeof name !== 'string' || !name.trim()) return fallback;
  const trimmed = name.trim();
  const cleaned = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.toLowerCase().endsWith(extension) ? cleaned : `${cleaned}${extension}`;
}

async function streamFileDownload({ res, filePath, filename, contentType, headers = {} }) {
  const stat = await fs.stat(filePath);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(stat.size));

  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, String(value));
  }

  res.status(200);
  await new Promise((resolve, reject) => {
    const stream = fss.createReadStream(filePath);
    stream.on('error', reject);
    res.on('error', reject);
    res.on('close', resolve);
    stream.pipe(res);
  });
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'forge3d-clean-export',
    mode: 'trimesh-only',
    timestamp: new Date().toISOString(),
    activeExports,
    maxParallelExports,
  });
});

app.get('/health/deps', async (_req, res) => {
  const assetRoot = process.env.ASSET_ROOT || path.resolve(process.cwd(), 'assets');
  const pythonBin = process.env.PYTHON_BIN || 'python3';
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

  const pythonVersion = spawnSync(pythonBin, ['--version'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  const trimeshCheck = spawnSync(
    pythonBin,
    ['-c', 'import trimesh, numpy; print(getattr(trimesh, "__version__", "ok"))'],
    {
      encoding: 'utf8',
      timeout: 15000,
    }
  );

  const pythonOk = pythonVersion.status === 0;
  const trimeshOk = trimeshCheck.status === 0;
  const missingAssets = fileChecks.filter((entry) => !entry.ok).map((entry) => entry.path);

  const response = {
    ok: pythonOk && trimeshOk && missingAssets.length === 0,
    python: {
      bin: pythonBin,
      ok: pythonOk,
      code: pythonVersion.status,
      stdout: (pythonVersion.stdout || '').trim(),
      stderr: (pythonVersion.stderr || '').trim(),
      trimeshOk,
      trimeshVersion: (trimeshCheck.stdout || '').trim(),
      trimeshError: (trimeshCheck.stderr || '').trim(),
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

async function runTrimeshExport(req, res, modeLabel) {
  const startedAt = Date.now();
  const jobId = crypto.randomUUID();
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

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge3d-trimesh-clean-export-'));
    const inputPath = path.join(tempDir, 'input.stl');
    const outputPath = path.join(tempDir, 'output.stl');
    await fs.writeFile(inputPath, req.body);

    await runTrimeshClean({
      jobId,
      inputPath,
      outputPath,
      timeoutMs: trimeshTimeoutMs,
    });

    const elapsedMs = Date.now() - startedAt;
    const filename = safeFilename(req.query?.filename, 'forge3d-clean-export.stl', '.stl');
    await streamFileDownload({
      res,
      filePath: outputPath,
      filename,
      contentType: 'model/stl',
      headers: {
        'X-Export-Job-Id': jobId,
        'X-Export-Duration-Ms': elapsedMs,
        'X-Export-Mode': modeLabel,
      },
    });
  } catch (error) {
    console.error('[trimesh-clean-export] failed', error);
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
}

app.post('/api/export-color-3mf', async (req, res) => {
  const startedAt = Date.now();
  const jobId = crypto.randomUUID();
  const color3mfTimeoutMs = Math.max(
    trimeshTimeoutMs,
    Number(process.env.COLOR_3MF_TIMEOUT_MS || 3 * 60 * 1000)
  );
  const assetRoot = process.env.ASSET_ROOT || path.resolve(process.cwd(), 'assets');
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

    const scene = req.body && typeof req.body === 'object' ? req.body : null;
    if (!scene || !Array.isArray(scene.tiles) || scene.tiles.length === 0) {
      return res.status(400).json({
        error: 'Scene payload missing or has no tiles.',
      });
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge3d-color-3mf-export-'));
    const scenePath = path.join(tempDir, 'scene.json');
    const outputPath = path.join(tempDir, 'output.3mf');
    await fs.writeFile(scenePath, JSON.stringify(scene), 'utf8');

    await runColor3mfExport({
      jobId,
      scenePath,
      outputPath,
      assetRoot,
      timeoutMs: color3mfTimeoutMs,
    });

    const elapsedMs = Date.now() - startedAt;
    const filename = safeFilename(req.query?.filename, 'forge3d-color-export.3mf', '.3mf');
    await streamFileDownload({
      res,
      filePath: outputPath,
      filename,
      contentType: 'model/3mf',
      headers: {
        'X-Export-Job-Id': jobId,
        'X-Export-Duration-Ms': elapsedMs,
        'X-Export-Mode': 'color-3mf',
      },
    });
  } catch (error) {
    console.error('[color-3mf-export] failed', error);
    res.status(500).json({
      error: (error && error.message) || 'Failed to generate color 3MF.',
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

app.post('/api/clean-export-trimesh-stl', rawStlParser, async (req, res) => {
  await runTrimeshExport(req, res, 'trimesh');
});

app.post('/api/clean-export-stl', rawStlParser, async (req, res) => {
  await runTrimeshExport(req, res, 'trimesh-fast');
});

app.post('/api/clean-export', (_req, res) => {
  res.status(410).json({
    error: 'Scene-JSON export endpoint retired. Use /api/clean-export-trimesh-stl with raw STL payload.',
  });
});

app.post('/api/clean-export/jobs', (_req, res) => {
  res.status(410).json({
    error: 'Queued full-repair export is retired in trimesh-only mode.',
  });
});

app.get('/api/clean-export/jobs', (_req, res) => {
  res.status(410).json({
    error: 'Queued full-repair export is retired in trimesh-only mode.',
  });
});

app.listen(port, () => {
  console.log(`forge3d-clean-export listening on :${port} (trimesh-only)`);
});
