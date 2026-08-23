import { Box, TextField } from '@mui/material';
import React from 'react';
import type { PluginSettings } from './links';

export interface SettingsProps {
  settings: PluginSettings;
  onChange: (settings: PluginSettings) => void;
}

/**
 * Fallback configuration for installs without a deployed config.json, such as
 * desktop Headlamp. A deployed config.json takes precedence over these values.
 */
export function SettingsForm({ onChange, settings }: SettingsProps): React.ReactElement {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 480 }}>
      <TextField
        fullWidth
        helperText="HTTPS, or HTTP on loopback. Used only when no config.json is deployed."
        label="SigNoz base URL"
        onChange={event => onChange({ ...settings, baseUrl: event.target.value })}
        placeholder="https://signoz.example.com"
        value={settings.baseUrl ?? ''}
      />
      <TextField
        helperText="5 to 360"
        inputProps={{ min: 5, max: 360 }}
        label="Time window (minutes)"
        onChange={event => onChange({ ...settings, windowMinutes: Number(event.target.value) })}
        type="number"
        value={settings.windowMinutes ?? 30}
      />
    </Box>
  );
}
