const { execFile } = require('child_process');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_PYTHON = process.env.MODAL_PYTHON_BIN || process.env.PYTHON_BIN || 'python';
const LAUNCHER_PATH = path.join(PROJECT_ROOT, 'docker_scripts', 'modal_training_launcher.py');

function parseJsonLine(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Keep looking for the final JSON line; Modal may print informational logs first.
    }
  }
  throw new Error(`Modal launcher did not return JSON. Output: ${stdout || '(empty)'}`);
}

function runLauncher(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(
      DEFAULT_PYTHON,
      [LAUNCHER_PATH, ...args],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const details = [stderr, stdout].filter(Boolean).join('\n').trim();
          error.message = details ? `${error.message}\n${details}` : error.message;
          reject(error);
          return;
        }
        try {
          resolve(parseJsonLine(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

function submitTrainingJob({ jobId, trainingKind, params }) {
  return runLauncher([
    'submit-training-job',
    '--job-id',
    jobId,
    '--training-kind',
    trainingKind,
    '--params-json',
    JSON.stringify(params || {}),
  ]);
}

function cancelModalCall({ modalCallId, terminateContainers = true }) {
  const args = ['cancel-call', '--modal-call-id', modalCallId];
  if (terminateContainers) args.push('--terminate-containers');
  return runLauncher(args, 60000);
}

module.exports = {
  cancelModalCall,
  submitTrainingJob,
};

