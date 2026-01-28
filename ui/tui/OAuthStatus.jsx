import React from 'react';
import { Box, Text, useInput } from 'ink';
import { extractEmailFromToken, getProfileStatus } from './utils/index.js';

// Profile card component
function ProfileCard({ name, profile, isSelected }) {
  const status = getProfileStatus(profile);
  const email = extractEmailFromToken(profile.accessToken || profile.idToken);
  const lastUsed = profile.lastUsedAt ? new Date(profile.lastUsedAt).toLocaleTimeString() : null;

  return (
    <Box
      flexDirection="column"
      borderStyle={isSelected ? 'double' : 'single'}
      borderColor={isSelected ? 'cyan' : 'gray'}
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={isSelected ? 'cyan' : 'white'}>{name}</Text>
        <Text color={status.color}>{status.icon} {status.text}</Text>
      </Box>

      {email && (
        <Text dimColor>{email}</Text>
      )}

      <Box marginTop={1} gap={2}>
        {profile.expiresAtMs && (
          <Text dimColor>
            Expires: {new Date(profile.expiresAtMs).toLocaleTimeString()}
          </Text>
        )}
        {lastUsed && (
          <Text dimColor>Last used: {lastUsed}</Text>
        )}
      </Box>
    </Box>
  );
}

// Main OAuth Status component
export default function OAuthStatus({ oauthPool, onClose }) {
  useInput((input, key) => {
    if (key.escape || key.return || (key.ctrl && input === 'c')) {
      onClose?.();
    }
  });

  const profiles = oauthPool?.profiles || {};
  const profileNames = Object.keys(profiles);
  const strategy = oauthPool?.strategy || 'sticky';
  const pinnedProfile = oauthPool?.pinned || oauthPool?.pinnedProfile;
  const lastUsedProfile = oauthPool?.lastUsedProfile;

  // Calculate summary stats
  const stats = {
    total: profileNames.length,
    ready: 0,
    rateLimited: 0,
    expired: 0,
    disabled: 0,
  };

  for (const name of profileNames) {
    const status = getProfileStatus(profiles[name]);
    if (status.status === 'ready') stats.ready++;
    else if (status.status === 'rate_limited') stats.rateLimited++;
    else if (status.status === 'expired') stats.expired++;
    else if (status.status === 'disabled') stats.disabled++;
  }

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1} marginBottom={1}>
        <Text bold color="cyan"> OAUTH STATUS </Text>
      </Box>

      {/* Summary bar */}
      <Box marginBottom={1} gap={2} paddingX={1}>
        <Text>
          <Text color="green">{stats.ready}</Text> ready
        </Text>
        {stats.rateLimited > 0 && (
          <Text>
            <Text color="yellow">{stats.rateLimited}</Text> rate limited
          </Text>
        )}
        {stats.expired > 0 && (
          <Text>
            <Text color="red">{stats.expired}</Text> expired
          </Text>
        )}
        {stats.disabled > 0 && (
          <Text>
            <Text color="gray">{stats.disabled}</Text> disabled
          </Text>
        )}
        <Text dimColor>| Strategy: {strategy}</Text>
        {pinnedProfile && <Text dimColor>| Pinned: {pinnedProfile}</Text>}
      </Box>

      {/* Profile cards */}
      <Box flexDirection="column" paddingX={1}>
        {profileNames.length === 0 ? (
          <Box paddingY={1}>
            <Text color="yellow">No OAuth profiles configured.</Text>
          </Box>
        ) : (
          profileNames.map((name) => (
            <ProfileCard
              key={name}
              name={name}
              profile={profiles[name]}
              isSelected={name === lastUsedProfile || name === pinnedProfile}
            />
          ))
        )}
      </Box>

      {/* Footer */}
      <Box marginTop={1} paddingX={1}>
        <Text dimColor>Press <Text color="gray">Esc</Text> or <Text color="gray">Enter</Text> to return</Text>
      </Box>
    </Box>
  );
}
