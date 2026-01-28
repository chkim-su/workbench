import React, { memo } from 'react';
import { Box, Text } from 'ink';

/**
 * Trace kind styling configuration
 * Maps trace kinds to their visual appearance
 */
const TRACE_STYLES = {
  think: { color: 'yellow', prefix: '[think] ', italic: true, dim: false },  // Removed dim for visibility
  tool_use: { color: 'cyan', prefix: '[tool] ', italic: false, dim: false, bold: true },
  step_start: { color: 'blue', prefix: '> ', italic: false, dim: false, bold: true },
  step_finish: { color: 'green', prefix: '< ', italic: false, dim: true },  // Green for completion
  info: { color: 'gray', prefix: '', italic: false, dim: true },
  error: { color: 'red', prefix: '[error] ', italic: false, dim: false, bold: true },
};

/**
 * Renders a single trace event with kind-based styling.
 * Memoized to prevent re-renders when parent state changes.
 *
 * @param {Object} props
 * @param {string} props.kind - Event kind (think, tool_use, step_start, info, error, etc.)
 * @param {string} props.message - The trace message content
 * @param {string|null} props.tool - Optional tool name for tool_use events
 */
const TraceMessage = memo(function TraceMessage({ kind, message, tool }) {
  const style = TRACE_STYLES[kind] || TRACE_STYLES.info;

  // Build the display message
  let displayMsg = message || '';

  // For tool_use, include the tool name
  if (kind === 'tool_use' && tool) {
    displayMsg = `${tool}: ${displayMsg}`;
  }

  // Truncate very long messages to prevent layout overflow
  const maxLen = 120;
  if (displayMsg.length > maxLen) {
    displayMsg = displayMsg.slice(0, maxLen - 3) + '...';
  }

  return (
    <Box>
      <Text
        color={style.color}
        bold={style.bold}
        dimColor={style.dim}
        italic={style.italic}
      >
        {style.prefix}{displayMsg}
      </Text>
    </Box>
  );
});

export default TraceMessage;
