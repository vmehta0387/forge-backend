const { spawn } = require('child_process');
const path = require('path');

const MAX_CAPTURED_LOG_CHARS = 12000;

function runPythonScript({
  jobId,
  scriptPath,
  scriptArgs,
  timeoutMs = 2 * 60 * 1000,
}) {
  const pythonBin = process.env.PYTHON_BIN || 'python3';

  const args = [scriptPath, ...scriptArgs];

  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '1',
        OPENBLAS_NUM_THREADS: process.env.OPENBLAS_NUM_THREADS || '1',
        MKL_NUM_THREADS: process.env.MKL_NUM_THREADS || '1',
        NUMEXPR_NUM_THREADS: process.env.NUMEXPR_NUM_THREADS || '1',
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (stdout.length < MAX_CAPTURED_LOG_CHARS) {
        stdout += text.slice(0, MAX_CAPTURED_LOG_CHARS - stdout.length);
      }
      process.stdout.write(`[mesh-clean:${jobId}] ${text}`);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (stderr.length < MAX_CAPTURED_LOG_CHARS) {
        stderr += text.slice(0, MAX_CAPTURED_LOG_CHARS - stderr.length);
      }
      process.stderr.write(`[mesh-clean:${jobId}] ${text}`);
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Trimesh clean timed out after ${timeoutMs}ms.`));
        return;
      }

      if (code !== 0) {
        const logs = stderr || stdout || 'No Python logs were captured.';
        const err = new Error(
          `Python cleaner exited with code ${code}.` +
            (signal ? ` signal=${signal}.` : '') +
            `\n${logs}`
        );
        err.exitCode = code;
        err.signal = signal;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function runTrimeshClean({
  jobId,
  inputPath,
  outputPath,
  timeoutMs = 2 * 60 * 1000,
}) {
  const scriptPath = path.resolve(__dirname, '../scripts/trimesh_clean_stl.py');
  return runPythonScript({
    jobId,
    scriptPath,
    scriptArgs: ['--input', inputPath, '--output', outputPath],
    timeoutMs,
  });
}

function runColor3mfExport({
  jobId,
  scenePath,
  outputPath,
  assetRoot,
  timeoutMs = 3 * 60 * 1000,
}) {
  const scriptPath = path.resolve(__dirname, '../scripts/export_color_3mf.py');
  return runPythonScript({
    jobId,
    scriptPath,
    scriptArgs: ['--scene', scenePath, '--output', outputPath, '--asset-root', assetRoot],
    timeoutMs,
  });
}

function runSceneStlExport({
  jobId,
  scenePath,
  outputPath,
  assetRoot,
  timeoutMs = 3 * 60 * 1000,
}) {
  const scriptPath = path.resolve(__dirname, '../scripts/export_scene_stl.py');
  return runPythonScript({
    jobId,
    scriptPath,
    scriptArgs: ['--scene', scenePath, '--output', outputPath, '--asset-root', assetRoot],
    timeoutMs,
  });
}

module.exports = {
  runTrimeshClean,
  runColor3mfExport,
  runSceneStlExport,
};
