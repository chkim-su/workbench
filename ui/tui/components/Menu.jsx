import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

/**
 * Custom menu component with reliable arrow key navigation.
 * Uses direct useInput handling like ModeSelector for consistent behavior.
 * Replaces @inkjs/ui Select which has input handling issues.
 */
export default function Menu({ options, onSelect, title, showHint = true }) {
  const [selected, setSelected] = useState(0);

  // Reset selection when options change
  useEffect(() => {
    setSelected(0);
  }, [options.length]);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelected(s => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelected(s => Math.min(options.length - 1, s + 1));
      return;
    }
    if (key.return) {
      const opt = options[selected];
      if (opt) {
        onSelect(opt.value);
      }
      return;
    }
    // Number key shortcuts (1-9)
    const num = parseInt(input, 10);
    if (num >= 1 && num <= Math.min(9, options.length)) {
      const opt = options[num - 1];
      if (opt) {
        onSelect(opt.value);
      }
    }
  });

  return (
    <Box flexDirection="column">
      {title && (
        <Box marginBottom={1}>
          <Text bold color="cyan">{title}</Text>
        </Box>
      )}
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        flexDirection="column"
        minWidth={40}
      >
        {options.map((opt, i) => (
          <Box key={opt.value} paddingY={0}>
            <Text
              color={i === selected ? 'cyan' : undefined}
              bold={i === selected}
              inverse={i === selected}
            >
              {i === selected ? ' > ' : '   '}
              {opt.label}
              {opt.label.length < 35 ? ' '.repeat(35 - opt.label.length) : ''}
            </Text>
          </Box>
        ))}
      </Box>
      {showHint && (
        <Box marginTop={1}>
          <Text dimColor>Use ↑↓ to navigate, Enter to select</Text>
        </Box>
      )}
    </Box>
  );
}
