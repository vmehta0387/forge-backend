const { spawn } = require('child_process');
const path = require('path');

const MAX_CAPTURED_LOG_CHARS = 12000;

function runBlenderScript({
  jobId,
  scriptPath,
  scriptArgs,
  timeoutMs = 6 * 60 * 1000,
}) {
  const blenderBin = process.env.BLENDER_BIN || 'blender';

  const args = [
    '-b',
    '--factory-startup',
    '--python-exit-code',
    '1',
    '-noaudio',
    '-P',
    scriptPath,
    '--',
    ...scriptArgs,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(blenderBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Keep Blender CPU thread usage low to reduce memory spikes on small Render instances.
        OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '1',
        OPENBLAS_NUM_THREADS: process.env.OPENBLAS_NUM_THREADS || '1',
        MKL_NUM_THREADS: process.env.MKL_NUM_THREADS || '1',
        NUMEXPR_NUM_THREADS: process.env.NUMEXPR_NUM_THREADS || '1',
        BLIS_NUM_THREADS: process.env.BLIS_NUM_THREADS || '1',
        VECLIB_MAXIMUM_THREADS: process.env.VECLIB_MAXIMUM_THREADS || '1',
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
      process.stdout.write(`[clean-export:${jobId}] ${text}`);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (stderr.length < MAX_CAPTURED_LOG_CHARS) {
        stderr += text.slice(0, MAX_CAPTURED_LOG_CHARS - stderr.length);
      }
      process.stderr.write(`[clean-export:${jobId}] ${text}`);
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Blender export timed out after ${timeoutMs}ms.`));
        return;
      }

      if (code !== 0) {
        const killedBySignal = code === null && signal;
        const hint = killedBySignal
          ? `Blender was terminated by signal ${signal}. This is commonly caused by OOM on low-memory instances.`
          : '';
        const logs = stderr || stdout || 'No Blender logs were captured.';
        const message =
          `Blender exited with code ${code}.` +
          (signal ? ` signal=${signal}.` : '') +
          `\n${hint}\n${logs}`;
        const err = new Error(message);
        err.exitCode = code;
        err.signal = signal;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(
          err
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function runBlenderExport({
  jobId,
  scenePath,
  outputPath,
  assetRoot,
  mode = 'robust',
  timeoutMs = 6 * 60 * 1000,
}) {
  const blenderScript = path.resolve(__dirname, '../scripts/clean_export.py');
  return runBlenderScript({
    jobId,
    scriptPath: blenderScript,
    scriptArgs: [
      '--scene',
      scenePath,
      '--output',
      outputPath,
      '--asset-root',
      assetRoot,
      '--mode',
      mode,
    ],
    timeoutMs,
  });
}

function runBlenderFastClean({
  jobId,
  inputPath,
  outputPath,
  decimateRatio,
  timeoutMs = 4 * 60 * 1000,
}) {
  const blenderScript = path.resolve(__dirname, '../scripts/fast_clean_stl.py');
  return runBlenderScript({
    jobId,
    scriptPath: blenderScript,
    scriptArgs: [
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--decimate-ratio',
      String(decimateRatio),
    ],
    timeoutMs,
  });
}

module.exports = {
  runBlenderExport,
  runBlenderFastClean,
};
