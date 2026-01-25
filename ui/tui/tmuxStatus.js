import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const STATUS_FORMAT =
  '#{session_name}|#{window_name}|#{window_index}|#{pane_index}|#{?pane_active,active,inactive}|#{pane_current_command}|#{pane_title}';

const DEFAULT_STATUS = {
  installed: false,
  sessionExists: false,
  sessions: [],
  panes: [],
  error: null,
};

export async function fetchTmuxStatus(sessionName = 'workbench', serverName = 'workbench') {
  const tmuxBin = serverName ? `tmux -L "${serverName}"` : 'tmux';
  try {
    await execAsync(`${tmuxBin} -V`);
  } catch (err) {
    const code = err?.code;
    if (code === 'ENOENT' || code === 127) {
      return { ...DEFAULT_STATUS, error: 'tmux not found on PATH' };
    }
    return { ...DEFAULT_STATUS, error: err?.message || 'Unable to query tmux' };
  }

  try {
    await execAsync(`${tmuxBin} has-session -t "${sessionName}"`);
  } catch {
    return {
      ...DEFAULT_STATUS,
      installed: true,
      sessionExists: false,
      error: `tmux session "${sessionName}" not running`,
    };
  }

  try {
    const { stdout: winOut } = await execAsync(`${tmuxBin} list-windows -t "${sessionName}" -F '#{window_index}'`);
    const windowIndices = winOut
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => !Number.isNaN(n));

    const allLines = [];
    for (const idx of windowIndices) {
      try {
        const { stdout } = await execAsync(`${tmuxBin} list-panes -t "${sessionName}:${idx}" -F "${STATUS_FORMAT}"`);
        allLines.push(
          ...stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        );
      } catch {
        // ignore missing windows
      }
    }

    const panes = allLines.map((line) => {
      const parts = line.split('|');
      const sessionPart = parts[0] || 'unknown';
      const windowName = parts[1] || 'unknown';
      const windowIndexStr = parts[2] || '';
      const paneIndexStr = parts[3] || '';
      const activeLabel = parts[4] || 'inactive';
      const command = parts[5] || '';
      const title = parts.slice(6).join('|') || '';
      return {
        sessionName: sessionPart || 'unknown',
        windowName,
        windowIndex: Number.isFinite(Number(windowIndexStr)) ? Number(windowIndexStr) : null,
        paneIndex: Number.isFinite(Number(paneIndexStr)) ? Number(paneIndexStr) : null,
        active: activeLabel === 'active',
        command,
        title,
      };
    });

    const sessions = panes.length ? [sessionName] : [];
    return {
      installed: true,
      sessionExists: true,
      sessions,
      panes,
      error: null,
    };
  } catch (err) {
    const message = err?.message || 'Unable to query tmux';
    return { ...DEFAULT_STATUS, installed: true, error: message };
  }
}
