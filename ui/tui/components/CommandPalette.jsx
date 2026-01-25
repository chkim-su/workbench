import React from 'react';
import { Box, Text } from 'ink';

/**
 * Command autocomplete overlay triggered by `/` or `//`
 * Shows filtered list of available slash commands
 */
export default function CommandPalette({ commands, filter, prefix = '/', selectedIndex, onSelect, onClose }) {
  const filtered = Object.entries(commands)
    .filter(([cmd]) => cmd.toLowerCase().includes(filter.toLowerCase()));

  if (filtered.length === 0) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>No matching commands</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginBottom={1}
    >
      <Box marginBottom={1}>
        <Text bold dimColor>Commands matching: </Text>
        <Text color="cyan">{prefix}{filter}</Text>
      </Box>
      {filtered.map(([cmd, desc], i) => (
        <Box key={cmd}>
          <Text color={i === selectedIndex ? 'cyan' : undefined} bold={i === selectedIndex}>
            {i === selectedIndex ? '> ' : '  '}{cmd.padEnd(12)}
          </Text>
          <Text dimColor>{desc}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>Use arrows to navigate, Enter to select, Esc to dismiss</Text>
      </Box>
    </Box>
  );
}
