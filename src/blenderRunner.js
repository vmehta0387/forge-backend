const { spawn } = require('child_process');
const path = require('path');

function runBlenderExport({
  jobId,
  scenePath,
  outputPath,
  assetRoot,
  timeoutMs = 6 * 60 * 1000,
}) {
  const blenderBin = process.env.BLENDER_BIN || 'blender';
  const blenderScript = path.resolve(__dirname, '../scripts/clean_export.py');

  const args = [
    '-b',
    '-noaudio',
    '-P',
    blenderScript,
    '--',
    '--scene',
    scenePath,
    '--output',
    outputPath,
    '--asset-root',
    assetRoot,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(blenderBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
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
      stdout += text;
      process.stdout.write(`[clean-export:${jobId}] ${text}`);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[clean-export:${jobId}] ${text}`);
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Blender export timed out after ${timeoutMs}ms.`));
        return;
      }

      if (code !== 0) {
        reject(
          new Error(
            `Blender exited with code ${code}.\n` +
              `${stderr || stdout || 'No Blender logs were captured.'}`
          )
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

module.exports = {
  runBlenderExport,
};

