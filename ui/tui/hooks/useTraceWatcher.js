import { useState, useEffect, useRef, useCallback } from 'react';
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';

/**
 * Hook that polls a JSONL events file for trace events during active turns.
 * Returns trace objects filtered by correlationId.
 *
 * Event format expected:
 * { version: 1, type: "turn.event", correlationId, at, kind, message, tool? }
 *
 * @param {Object} options
 * @param {string|null} options.eventsFilePath - Path to the JSONL events file
 * @param {string|null} options.correlationId - Filter events by this correlationId
 * @param {boolean} options.isActive - Whether to actively poll (typically during loading)
 * @param {number} options.pollIntervalMs - Polling interval in milliseconds (default: 250)
 * @returns {{ traces: Array, clearTraces: Function }}
 */
export function useTraceWatcher({
  eventsFilePath,
  correlationId,
  isActive,
  pollIntervalMs = 250,
}) {
  const [traces, setTraces] = useState([]);
  const offsetRef = useRef(0);
  const traceIdRef = useRef(0);

  // Clear traces and seek to end of file when starting a new turn
  const clearTraces = useCallback(() => {
    setTraces([]);
    traceIdRef.current = 0;

    // Seek to end of file to avoid reading old events
    if (eventsFilePath && existsSync(eventsFilePath)) {
      try {
        const stats = statSync(eventsFilePath);
        offsetRef.current = stats.size;
      } catch {
        offsetRef.current = 0;
      }
    } else {
      offsetRef.current = 0;
    }
  }, [eventsFilePath]);

  // Reset offset when file path changes
  useEffect(() => {
    if (eventsFilePath && existsSync(eventsFilePath)) {
      try {
        const stats = statSync(eventsFilePath);
        offsetRef.current = stats.size;
      } catch {
        offsetRef.current = 0;
      }
    } else {
      offsetRef.current = 0;
    }
  }, [eventsFilePath]);

  // Poll for new events
  useEffect(() => {
    if (!isActive || !eventsFilePath || !correlationId) {
      return;
    }

    const poll = () => {
      if (!existsSync(eventsFilePath)) return;

      let stats;
      try {
        stats = statSync(eventsFilePath);
      } catch {
        return;
      }

      // Handle file truncation/rotation
      if (offsetRef.current > stats.size) {
        offsetRef.current = 0;
      }

      // No new data
      if (offsetRef.current >= stats.size) {
        return;
      }

      // Read new content from offset
      const bytesToRead = stats.size - offsetRef.current;
      if (bytesToRead <= 0) return;

      let fd;
      try {
        fd = openSync(eventsFilePath, 'r');
        const buf = Buffer.alloc(bytesToRead);
        readSync(fd, buf, 0, bytesToRead, offsetRef.current);
        closeSync(fd);
        offsetRef.current = stats.size;

        const content = buf.toString('utf8');
        const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

        const newTraces = [];
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            // Filter by version, type, and correlationId
            if (
              ev?.version === 1 &&
              ev?.type === 'turn.event' &&
              ev?.correlationId === correlationId
            ) {
              newTraces.push({
                id: `trace-${++traceIdRef.current}`,
                kind: ev.kind || 'info',
                message: ev.message || '',
                tool: ev.tool || null,
                at: ev.at || new Date().toISOString(),
              });
            }
          } catch {
            // Skip malformed lines
          }
        }

        if (newTraces.length > 0) {
          setTraces(prev => [...prev, ...newTraces]);
        }
      } catch (e) {
        // Ignore read errors
        if (fd !== undefined) {
          try { closeSync(fd); } catch {}
        }
      }
    };

    // Initial poll
    poll();

    // Set up interval
    const interval = setInterval(poll, pollIntervalMs);
    return () => clearInterval(interval);
  }, [isActive, eventsFilePath, correlationId, pollIntervalMs]);

  return { traces, clearTraces };
}

export default useTraceWatcher;
