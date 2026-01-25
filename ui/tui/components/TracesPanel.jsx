import React, { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import TraceMessage from './TraceMessage.jsx';

/**
 * Container component for displaying reasoning traces.
 * Shows a bordered panel with trace events during active turns,
 * and can collapse to a summary when the turn is complete.
 *
 * @param {Object} props
 * @param {Array} props.traces - Array of trace objects { id, kind, message, tool, at }
 * @param {boolean} props.isActive - Whether the turn is currently active
 * @param {boolean} props.collapsed - Whether to show collapsed summary view
 * @param {Function} props.onToggle - Callback to toggle collapsed state
 */
const TracesPanel = memo(function TracesPanel({ traces, isActive, collapsed, onToggle }) {
  // Compute summary stats for collapsed view
  const summary = useMemo(() => {
    const counts = { think: 0, tool_use: 0, step_start: 0, error: 0, other: 0 };
    for (const t of traces) {
      if (counts.hasOwnProperty(t.kind)) {
        counts[t.kind]++;
      } else {
        counts.other++;
      }
    }
    return counts;
  }, [traces]);

  // Build collapsed summary text
  const summaryText = useMemo(() => {
    const parts = [];
    if (summary.think > 0) parts.push(`${summary.think} reasoning`);
    if (summary.tool_use > 0) parts.push(`${summary.tool_use} tool calls`);
    if (summary.step_start > 0) parts.push(`${summary.step_start} steps`);
    if (summary.error > 0) parts.push(`${summary.error} errors`);
    return parts.length > 0 ? parts.join(', ') : 'no traces';
  }, [summary]);

  // Don't render if no traces and not active
  if (traces.length === 0 && !isActive) {
    return null;
  }

  // Show collapsed summary view
  if (collapsed && traces.length > 0 && !isActive) {
    return (
      <Box
        flexDirection="row"
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        marginBottom={1}
      >
        <Text dimColor>Trace: {summaryText}</Text>
        <Text dimColor> (press </Text>
        <Text color="cyan">t</Text>
        <Text dimColor> to expand)</Text>
      </Box>
    );
  }

  // Limit displayed traces to prevent terminal overflow
  // Show last N traces when there are many
  const maxDisplay = 12;
  const displayTraces = traces.length > maxDisplay
    ? traces.slice(-maxDisplay)
    : traces;
  const hiddenCount = traces.length - displayTraces.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isActive ? 'yellow' : 'gray'}
      paddingX={1}
      marginBottom={1}
    >
      {/* Header */}
      <Box marginBottom={traces.length > 0 ? 1 : 0}>
        <Text bold color={isActive ? 'yellow' : 'gray'}>
          Reasoning Trace
        </Text>
        {isActive && (
          <Text color="yellow" dimColor> (live)</Text>
        )}
        {!isActive && traces.length > 0 && (
          <>
            <Text dimColor> | </Text>
            <Text dimColor>press </Text>
            <Text color="cyan">t</Text>
            <Text dimColor> to collapse</Text>
          </>
        )}
      </Box>

      {/* Hidden count indicator */}
      {hiddenCount > 0 && (
        <Box>
          <Text dimColor>... {hiddenCount} earlier trace(s) hidden ...</Text>
        </Box>
      )}

      {/* Trace list */}
      {displayTraces.map((trace) => (
        <TraceMessage
          key={trace.id}
          kind={trace.kind}
          message={trace.message}
          tool={trace.tool}
        />
      ))}

      {/* Empty state during active turn */}
      {traces.length === 0 && isActive && (
        <Text dimColor italic>Waiting for events...</Text>
      )}
    </Box>
  );
});

export default TracesPanel;
