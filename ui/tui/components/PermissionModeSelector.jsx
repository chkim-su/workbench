import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getPermissionModeList, DEFAULT_PERMISSION_MODE } from '../permissionModes.js';

/**
 * Permission mode selector for Codex executor.
 * Displayed after session mode selection.
 *
 * Modes:
 * - plan: Restricted (read-only; shell allowed)
 * - bypass: Override (workspace-write + shell allowed; still sandboxed)
 */
export default function PermissionModeSelector({ onSelect, onBack }) {
  const modes = getPermissionModeList();
  const defaultIndex = modes.findIndex(m => m.key === DEFAULT_PERMISSION_MODE);
  const [selected, setSelected] = useState(defaultIndex >= 0 ? defaultIndex : 0);

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
    if (key.escape && onBack) {
      onBack();
      return;
    }
    // Direct number selection (1, 2, 3)
    const num = parseInt(input, 10);
    if (num >= 1 && num <= modes.length) {
      onSelect(modes[num - 1].key);
      return;
    }
  });

  const getRiskIndicator = (riskLevel) => {
    switch (riskLevel) {
      case 'low':
        return { icon: '[SAFE]', color: 'green' };
      case 'medium':
        return { icon: '[MODERATE]', color: 'yellow' };
      case 'high':
        return { icon: '[CAUTION]', color: 'red' };
      default:
        return { icon: '', color: 'gray' };
    }
  };

  return (
    <Box flexDirection="column" alignItems="center" paddingY={2}>
      <Box
        borderStyle="double"
        borderColor="cyan"
        paddingX={4}
        paddingY={1}
        marginBottom={2}
      >
        <Text bold color="cyan">SELECT PERMISSION MODE</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>Controls Codex executor sandbox and shell access</Text>
      </Box>

      <Box flexDirection="column" marginY={1}>
        {modes.map((m, i) => {
          const risk = getRiskIndicator(m.riskLevel);
          const isSelected = i === selected;
          return (
            <Box
              key={m.key}
              flexDirection="column"
              marginY={1}
              paddingX={2}
              paddingY={1}
              borderStyle={isSelected ? 'round' : undefined}
              borderColor={isSelected ? m.color : undefined}
            >
              <Box>
                <Text
                  color={isSelected ? m.color : undefined}
                  bold={isSelected}
                >
                  {isSelected ? '> ' : '  '}
                </Text>
                <Text
                  color={isSelected ? m.color : undefined}
                  bold={isSelected}
                >
                  [{i + 1}] {m.label}
                </Text>
                <Text> </Text>
                <Text color={risk.color} bold={isSelected}>
                  {risk.icon}
                </Text>
              </Box>
              <Box paddingLeft={4}>
                <Text dimColor>{m.description}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Warning for bypass mode */}
      {modes[selected]?.riskLevel === 'high' && (
        <Box
          borderStyle="single"
          borderColor="red"
          paddingX={2}
          paddingY={1}
          marginTop={1}
        >
          <Text color="red">
            Warning: Bypass mode grants full filesystem and shell access.
            Use only when necessary.
          </Text>
        </Box>
      )}

      <Box marginTop={2} flexDirection="column" alignItems="center">
        <Text dimColor>Press 1-3 or use arrow keys + Enter</Text>
        {onBack && (
          <Box marginTop={1}>
            <Text dimColor>Esc to go back</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
