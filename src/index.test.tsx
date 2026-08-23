import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { configurationUrl, SignalLinkMenu, SigNozResourceActions } from './index';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ConfigStore: class {
    get() {
      return {};
    }
    set() {}
    useConfig() {
      return () => ({});
    }
  },
  registerDetailsViewHeaderActionsProcessor: vi.fn(),
  registerPluginSettings: vi.fn(),
}));

describe('Headlamp integration', () => {
  it('renders external menu links with opener isolation and no embedded content', () => {
    render(
      <SignalLinkMenu
        links={{
          errors: 'https://signoz.example.com/traces-explorer?errors',
          logs: 'https://signoz.example.com/logs/logs-explorer',
          metrics: 'https://signoz.example.com/metrics-explorer/explorer',
          traces: 'https://signoz.example.com/traces-explorer',
        }}
        scope="Deployment checkout-api"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open in SigNoz' }));
    expect(screen.getByText('Deployment checkout-api')).toBeTruthy();
    const items = screen.getAllByRole('menuitem');
    expect(items.map(item => item.textContent)).toEqual(['Logs', 'Metrics', 'Traces', 'Errors']);
    for (const item of items) {
      expect(item.getAttribute('target')).toBe('_blank');
      expect(item.getAttribute('rel')).toBe('noopener noreferrer');
      expect(item.getAttribute('href')).toContain('signoz.example.com');
    }
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('resolves immutable config under the Headlamp application base', () => {
    expect(configurationUrl({ origin: 'https://headlamp.example.com' }, '/headlamp/')).toBe(
      'https://headlamp.example.com/headlamp/static-plugins/signoz-observability-links/config.json'
    );
  });

  it('renders no actions when configuration JSON is malformed', async () => {
    const fetcher = vi.fn(async () => new Response('{', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    render(
      <SigNozResourceActions
        item={{
          cluster: 'worker-a',
          kind: 'Pod',
          metadata: { name: 'pod-a', namespace: 'research' },
        }}
      />
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: 'Open in SigNoz' })).toBeNull();
    vi.unstubAllGlobals();
  });
});
