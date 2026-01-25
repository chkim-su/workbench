import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

/**
 * Startup screen for mode selection
 * Mode A: Controlled Mode - Delegator/Executor, phase review, real tests
 * Mode B: Compatibility Mode - General LLM with optional workflow
 */
export default function ModeSelector({ onSelect }) {
  const [selected, setSelected] = useState(0);
  const modes = [
    {
      key: 'A',
      label: 'Controlled Mode',
      desc: 'Delegator/Executor, phase review, real tests',
      color: 'green',
    },
    {
      key: 'B',
      label: 'Compatibility Mode',
      desc: 'General LLM with optional workflow',
      color: 'yellow',
    },
  ];

  useInput((input, key) => {
    if (key.upArrow) {
      setSelected(s => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelected(s => Math.min(modes.length - 1, s + 1));
      return;
    }
    if (key.return) {
      onSelect(modes[selected].key);
      return;
    }
    // Direct key selection
    const upperInput = input?.toUpperCase?.();
    if (upperInput === 'A') {
      onSelect('A');
      return;
    }
    if (upperInput === 'B') {
      onSelect('B');
      return;
    }
  });

  return (
    <Box flexDirection="column" alignItems="center" paddingY={2}>
      <Box
        borderStyle="double"
        borderColor="cyan"
        paddingX={4}
        paddingY={1}
        marginBottom={2}
      >
        <Text bold color="cyan">SELECT SESSION MODE</Text>
      </Box>

      <Box flexDirection="column" marginY={1}>
        {modes.map((m, i) => (
          <Box
            key={m.key}
            flexDirection="column"
            marginY={1}
            paddingX={2}
            paddingY={1}
            borderStyle={i === selected ? 'round' : undefined}
            borderColor={i === selected ? m.color : undefined}
          >
            <Box>
              <Text
                color={i === selected ? m.color : undefined}
                bold={i === selected}
              >
                {i === selected ? '> ' : '  '}
              </Text>
              <Text
                color={i === selected ? m.color : undefined}
                bold={i === selected}
              >
                [{m.key}] {m.label}
              </Text>
            </Box>
            <Box paddingLeft={4}>
              <Text dimColor>{m.desc}</Text>
            </Box>
          </Box>
        ))}
      </Box>

      <Box marginTop={2} flexDirection="column" alignItems="center">
        <Text dimColor>Press A, B, or use arrow keys + Enter</Text>
        <Box marginTop={1}>
          <Text dimColor>Mode determines session behavior per CLAUDE.md</Text>
        </Box>
      </Box>
    </Box>
  );
}
