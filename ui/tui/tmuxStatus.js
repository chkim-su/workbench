import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const STATUS_FORMAT =
  '#{session_name}|#{window_name}|#{window_index}|#{pane_index}|#{?pane_active,active,inactive}|#{pane_current_command}|#{pane_title}|#{@workbench_pane_role}';

// Fixed pane slot definitions for Workbench layout
// These match the expected pane roles set in tmux_start.sh
const PANE_SLOT_ROLES = ['main', 'docker', 'status', 'command'];

const DEFAULT_STATUS = {
  installed: false,
  sessionExists: false,
  sessions: [],
  panes: [],
  paneSlots: [null, null, null, null], // Fixed 4 slots for main, docker, status, command
  emptySlots: [0, 1, 2, 3],
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
      const title = parts[6] || '';
      const role = parts[7] || '';
      return {
        sessionName: sessionPart || 'unknown',
        windowName,
        windowIndex: Number.isFinite(Number(windowIndexStr)) ? Number(windowIndexStr) : null,
        paneIndex: Number.isFinite(Number(paneIndexStr)) ? Number(paneIndexStr) : null,
        active: activeLabel === 'active',
        command,
        title,
        role,
      };
    });

    // Build pane slots array (null for missing panes)
    const controlPanes = panes.filter(p => p.windowName === 'control');
    const paneSlots = PANE_SLOT_ROLES.map((expectedRole, slotIndex) => {
      const pane = controlPanes.find(p => p.role === expectedRole) ||
                   controlPanes.find(p => p.paneIndex === slotIndex);
      if (pane) {
        return { ...pane, slotIndex, expectedRole, active: true };
      }
      // Slot is empty (pane was closed)
      return null;
    });

    const sessions = panes.length ? [sessionName] : [];
    return {
      installed: true,
      sessionExists: true,
      sessions,
      panes,
      paneSlots,
      emptySlots: paneSlots.map((s, i) => s === null ? i : null).filter(i => i !== null),
      error: null,
    };
  } catch (err) {
    const message = err?.message || 'Unable to query tmux';
    return { ...DEFAULT_STATUS, installed: true, error: message };
  }
}
