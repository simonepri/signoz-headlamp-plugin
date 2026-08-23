import { Icon } from '@iconify/react';
import {
  ConfigStore,
  registerDetailsViewHeaderActionsProcessor,
  registerPluginSettings,
} from '@kinvolk/headlamp-plugin/lib';
import {
  IconButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Menu,
  MenuItem,
  Tooltip,
} from '@mui/material';
import React, { useEffect, useState } from 'react';
import type { KubernetesResource, PluginSettings, SignalLinks } from './links';
import {
  buildSignalLinks,
  configurationFromSettings,
  loadConfiguration,
  PLUGIN_NAME,
} from './links';
import { SettingsForm } from './settings';
import {
  configuredLinkBuilder,
  hasAction,
  ownString,
  pluginConfigurationUrlBuilder,
  resourceParts,
  updateWhileMounted,
  withActionInserted,
} from './shared';

const METRICS_ACTION_ID = 'prom_metrics';

export const configurationUrl = pluginConfigurationUrlBuilder(PLUGIN_NAME);

const settingsStore = new ConfigStore<PluginSettings>(PLUGIN_NAME);

// A deployed config.json is authoritative. Plugin settings only apply where no
// deployment supplies one, such as desktop Headlamp.
const configuredLinks = configuredLinkBuilder(
  () =>
    loadConfiguration(configurationUrl()).catch(() =>
      configurationFromSettings(settingsStore.get())
    ),
  buildSignalLinks
);

export function menuScope(resource: KubernetesResource): string {
  const { kind, metadata } = resourceParts(resource);
  const name = ownString(metadata, 'name');
  return [kind, name].filter(Boolean).join(' ') || 'Resource';
}

const SIGNAL_ENTRIES = [
  ['Logs', 'logs', 'mdi:file-document-outline'],
  ['Metrics', 'metrics', 'mdi:chart-line'],
  ['Traces', 'traces', 'mdi:transit-connection-variant'],
  ['Errors', 'errors', 'mdi:alert-circle-outline'],
] as const;

export function SignalLinkMenu({
  links,
  scope,
}: {
  links: SignalLinks;
  scope: string;
}): React.ReactElement {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <Tooltip title="Open in SigNoz">
        <IconButton aria-label="Open in SigNoz" onClick={event => setAnchor(event.currentTarget)}>
          <Icon icon="mdi:telescope" width="20" />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} onClose={() => setAnchor(null)} open={anchor !== null}>
        <ListSubheader>{scope}</ListSubheader>
        {SIGNAL_ENTRIES.map(([label, key, icon]) => (
          <MenuItem
            component="a"
            href={links[key]}
            key={key}
            onClick={() => setAnchor(null)}
            rel="noopener noreferrer"
            target="_blank"
          >
            <ListItemIcon>
              <Icon icon={icon} width="20" />
            </ListItemIcon>
            <ListItemText>{label}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

export function SigNozResourceActions({
  item,
}: {
  item: KubernetesResource;
}): React.ReactElement | null {
  const [links, setLinks] = useState<SignalLinks | null>(null);

  useEffect(() => {
    return updateWhileMounted(configuredLinks(item), setLinks);
  }, [item]);

  return links ? <SignalLinkMenu links={links} scope={menuScope(item)} /> : null;
}

registerDetailsViewHeaderActionsProcessor({
  id: PLUGIN_NAME,
  processor: (resource, actions) => {
    if (!resource || hasAction(actions, PLUGIN_NAME)) {
      return actions;
    }
    return withActionInserted(
      actions,
      { id: PLUGIN_NAME, action: SigNozResourceActions },
      METRICS_ACTION_ID
    );
  },
});

registerPluginSettings(
  PLUGIN_NAME,
  () => {
    const settings = settingsStore.useConfig()() ?? {};
    return <SettingsForm onChange={next => settingsStore.set(next)} settings={settings} />;
  },
  false
);
