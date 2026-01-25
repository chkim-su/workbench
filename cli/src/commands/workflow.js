/**
 * Workflow command - Workflow operations.
 *
 * Subcommands:
 *   status              Show current workflow status
 *   init <task>         Initialize a new workflow
 *   cancel [id]         Cancel active workflow
 *   history             Show workflow history
 */

import http from 'node:http';
import https from 'node:https';

/**
 * Make an HTTP request.
 * @param {string} url
 * @param {Object} [options]
 * @returns {Promise<{ok: boolean, status: number, data: any, error?: string}>}
 */
function httpRequest(url, options = {}) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      timeout: options.timeout || 5000,
    };

    const req = client.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            data: parsed,
          });
        } catch {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            data: data,
          });
        }
      });
    });

    req.on('error', (err) => {
      resolve({
        ok: false,
        status: 0,
        data: null,
        error: err.message,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        ok: false,
        status: 0,
        data: null,
        error: 'Request timed out',
      });
    });

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }

    req.end();
  });
}

/**
 * Get the workflow daemon URL.
 * @returns {string}
 */
function getDaemonUrl() {
  return process.env.WORKFLOW_ENGINE_URL || 'http://127.0.0.1:8766';
}

/**
 * Get the session ID.
 * @returns {string}
 */
function getSessionId() {
  return process.env.CSC_SESSION_ID || 'default';
}

/**
 * Parse command-line arguments for workflow command.
 * @param {string[]} args
 * @returns {Object}
 */
function parseWorkflowArgs(args) {
  const result = {
    action: args[0] || 'status',
    workflowId: null,
    sessionId: getSessionId(),
    task: null,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--workflow-id' || arg === '-w') {
      result.workflowId = args[++i];
    } else if (arg === '--session-id' || arg === '-s') {
      result.sessionId = args[++i];
    } else if (arg === '--task' || arg === '-t') {
      result.task = args[++i];
    } else if (!arg.startsWith('-')) {
      // Positional argument based on action
      if (result.action === 'init') {
        result.task = arg;
      } else if (result.action === 'cancel') {
        result.workflowId = arg;
      }
    }
  }

  return result;
}

/**
 * Get workflow status.
 * @param {Object} context
 * @param {Object} args
 * @returns {Promise<Object>}
 */
async function getStatus(context, args) {
  const { logger, output } = context;
  const baseUrl = getDaemonUrl();

  // First get current workflow ID if not specified
  let workflowId = args.workflowId;
  if (!workflowId) {
    const currentIdRes = await httpRequest(
      `${baseUrl}/workflow/current-id?session_id=${encodeURIComponent(args.sessionId)}`
    );
    if (currentIdRes.ok && currentIdRes.data?.workflow_id) {
      workflowId = currentIdRes.data.workflow_id;
    }
  }

  if (!workflowId) {
    return {
      found: false,
      message: 'No active workflow found',
      sessionId: args.sessionId,
    };
  }

  // Get workflow status
  const statusRes = await httpRequest(
    `${baseUrl}/workflow/status?workflow_id=${encodeURIComponent(workflowId)}&session_id=${encodeURIComponent(args.sessionId)}`
  );

  if (!statusRes.ok) {
    return {
      found: false,
      message: statusRes.error || `Workflow ${workflowId} not found`,
      workflowId,
      sessionId: args.sessionId,
    };
  }

  return {
    found: true,
    workflowId,
    sessionId: args.sessionId,
    ...statusRes.data,
  };
}

/**
 * Initialize a new workflow.
 * @param {Object} context
 * @param {Object} args
 * @returns {Promise<Object>}
 */
async function initWorkflow(context, args) {
  const { logger, output } = context;
  const baseUrl = getDaemonUrl();

  if (!args.task) {
    throw new Error('Task is required for init. Use: workflow init "your task"');
  }

  const res = await httpRequest(`${baseUrl}/workflow/init`, {
    method: 'POST',
    body: {
      session_id: args.sessionId,
      task: args.task,
    },
  });

  if (!res.ok) {
    throw new Error(res.error || res.data?.detail || 'Failed to initialize workflow');
  }

  return {
    success: true,
    message: 'Workflow initialized',
    ...res.data,
  };
}

/**
 * Cancel a workflow.
 * @param {Object} context
 * @param {Object} args
 * @returns {Promise<Object>}
 */
async function cancelWorkflow(context, args) {
  const { logger, output } = context;
  const baseUrl = getDaemonUrl();

  // Get current workflow ID if not specified
  let workflowId = args.workflowId;
  if (!workflowId) {
    const currentIdRes = await httpRequest(
      `${baseUrl}/workflow/current-id?session_id=${encodeURIComponent(args.sessionId)}`
    );
    if (currentIdRes.ok && currentIdRes.data?.workflow_id) {
      workflowId = currentIdRes.data.workflow_id;
    }
  }

  if (!workflowId) {
    throw new Error('No active workflow to cancel');
  }

  const res = await httpRequest(
    `${baseUrl}/workflow/cancel?workflow_id=${encodeURIComponent(workflowId)}&session_id=${encodeURIComponent(args.sessionId)}&reason=CLI%20cancellation`,
    { method: 'POST' }
  );

  if (!res.ok) {
    throw new Error(res.error || res.data?.detail || 'Failed to cancel workflow');
  }

  return {
    success: true,
    message: `Workflow ${workflowId} cancelled`,
    workflowId,
    sessionId: args.sessionId,
  };
}

/**
 * Get workflow history (debug state).
 * @param {Object} context
 * @param {Object} args
 * @returns {Promise<Object>}
 */
async function getHistory(context, args) {
  const { logger, output } = context;
  const baseUrl = getDaemonUrl();

  const res = await httpRequest(`${baseUrl}/debug/state`);

  if (!res.ok) {
    throw new Error(res.error || 'Failed to get workflow history');
  }

  return {
    ...res.data,
    sessionId: args.sessionId,
  };
}

/**
 * Run the workflow command.
 * @param {string[]} args
 * @param {Object} context
 * @returns {Promise<number>}
 */
export async function run(args, context) {
  const { logger, output } = context;
  const workflowArgs = parseWorkflowArgs(args);

  logger.info('workflow_start', `Workflow action: ${workflowArgs.action}`, workflowArgs);

  // Check daemon health first
  const baseUrl = getDaemonUrl();
  const healthRes = await httpRequest(`${baseUrl}/health`);

  if (!healthRes.ok) {
    logger.error('workflow_daemon_offline', 'Workflow daemon is not running');
    output.writeError(
      'DAEMON_OFFLINE',
      'Workflow daemon is not running',
      { url: baseUrl, suggestion: 'Start the daemon with: csc <preset>' }
    );
    return 1;
  }

  try {
    let result;

    switch (workflowArgs.action) {
      case 'status':
        output.progress('Getting workflow status...');
        result = await getStatus(context, workflowArgs);
        break;

      case 'init':
        output.progress('Initializing workflow...');
        result = await initWorkflow(context, workflowArgs);
        break;

      case 'cancel':
        output.progress('Cancelling workflow...');
        result = await cancelWorkflow(context, workflowArgs);
        break;

      case 'history':
        output.progress('Getting workflow history...');
        result = await getHistory(context, workflowArgs);
        break;

      default:
        throw new Error(`Unknown workflow action: ${workflowArgs.action}. Valid actions: status, init, cancel, history`);
    }

    logger.info('workflow_complete', `Workflow action ${workflowArgs.action} completed`, result);
    output.writeSuccess(result);
    return 0;

  } catch (err) {
    logger.error('workflow_error', `Workflow action failed: ${err.message}`);
    output.writeError('WORKFLOW_ERROR', err.message);
    return 1;
  }
}

export default { run };
