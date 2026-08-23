import { describe, expect, it, vi } from 'vitest';
import {
  buildSignalLinks,
  configurationFromSettings,
  correlationExpression,
  loadConfiguration,
  validateConfiguration,
} from './links';

const RAW_CONFIG = {
  schemaVersion: 1,
  signozBaseUrl: 'https://signoz.example.com',
  allowedOrigins: ['https://signoz.example.com'],
  windowMinutes: 30,
  correlation: {
    runLabelKeys: ['openplex.io/run-id'],
    runAttribute: 'openplex.run.id',
    containerLabelKeys: ['openplex.io/container'],
    containerAttribute: 'k8s.container.name',
  },
};

describe('configuration policy', () => {
  it('accepts an exact HTTPS origin and browser loopback', () => {
    expect(validateConfiguration(RAW_CONFIG).signozBaseUrl).toBe('https://signoz.example.com');
    expect(
      validateConfiguration({
        ...RAW_CONFIG,
        signozBaseUrl: 'http://127.0.0.1:18084',
        allowedOrigins: ['http://127.0.0.1:18084'],
      }).allowedOrigins
    ).toEqual(['http://127.0.0.1:18084']);
  });

  it.each([
    {
      ...RAW_CONFIG,
      signozBaseUrl: 'https://signoz.example.com.evil.invalid',
    },
    {
      ...RAW_CONFIG,
      signozBaseUrl: 'https://user:password@signoz.example.com',
    },
    {
      ...RAW_CONFIG,
      signozBaseUrl: 'http://signoz.example.com',
      allowedOrigins: ['http://signoz.example.com'],
    },
    { ...RAW_CONFIG, windowMinutes: 4 },
    { ...RAW_CONFIG, windowMinutes: 361 },
  ])('rejects unsafe or unbounded configuration', candidate => {
    expect(() => validateConfiguration(candidate)).toThrow();
  });

  it('limits config response size and validates fetched JSON', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(RAW_CONFIG), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    await expect(loadConfiguration('/config.json', fetcher)).resolves.toEqual(
      validateConfiguration(RAW_CONFIG)
    );
    expect(fetcher).toHaveBeenCalledWith('/config.json', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  });

  it.each([
    ['missing', vi.fn(async () => new Response('', { status: 404 }))],
    ['malformed', vi.fn(async () => new Response('{', { status: 200 }))],
  ])('rejects %s configuration responses', async (_case, fetcher) => {
    await expect(loadConfiguration('/config.json', fetcher)).rejects.toThrow();
  });
});

describe('settings fallback', () => {
  it('allowlists the origin the user typed and applies defaults', () => {
    const config = configurationFromSettings({ baseUrl: 'https://signoz.example.com' });
    expect(config.allowedOrigins).toEqual(['https://signoz.example.com']);
    expect(config.windowMinutes).toBe(30);
    expect(config.correlation.runLabelKeys).toEqual([]);
  });

  it.each([
    {},
    { baseUrl: '' },
    { baseUrl: 'http://signoz.example.com' },
    { baseUrl: 'https://signoz.example.com', windowMinutes: 361 },
  ])('rejects unusable settings', settings => {
    expect(() => configurationFromSettings(settings)).toThrow();
  });
});

describe('SigNoz links', () => {
  it('carries trusted cluster, namespace, workload, container, and run identity', () => {
    const config = validateConfiguration(RAW_CONFIG);
    const links = buildSignalLinks(
      {
        cluster: 'management',
        kind: 'Job',
        metadata: { name: 'etl-run', namespace: 'research' },
        jsonData: {
          kind: 'Job',
          metadata: { name: 'etl-run', namespace: 'research' },
          spec: {
            template: {
              metadata: { labels: { 'openplex.io/run-id': 'run-42' } },
              spec: { containers: [{ name: 'worker' }] },
            },
          },
        },
      },
      config
    );
    expect(links).not.toBeNull();

    const logs = new URL(links!.logs);
    expect(logs.origin).toBe('https://signoz.example.com');
    expect(logs.pathname).toBe('/logs/logs-explorer');
    expect(logs.searchParams.get('relativeTime')).toBe('30m');
    const query = JSON.parse(logs.searchParams.get('compositeQuery')!);
    const expression = query.builder.queryData[0].filter.expression;
    expect(expression).toContain("k8s.cluster.name = 'management'");
    expect(expression).toContain("k8s.namespace.name = 'research'");
    expect(expression).toContain("k8s.job.name = 'etl-run'");
    expect(expression).toContain("k8s.container.name = 'worker'");
    expect(expression).toContain("openplex.run.id = 'run-42'");

    const metrics = new URL(links!.metrics!);
    expect(metrics.pathname).toBe('/metrics-explorer/explorer');
    expect(metrics.searchParams.get('panelType')).toBe('graph');
    expect(metrics.searchParams.get('relativeTime')).toBe('30m');
    const metricsQuery = JSON.parse(metrics.searchParams.get('compositeQuery')!);
    expect(metricsQuery.builder.queryData[0].aggregations[0].metricName).toBe(
      'container.cpu.usage'
    );
    expect(metricsQuery.builder.queryData[0].filter.expression).toBe(expression);

    const traces = new URL(links!.traces);
    expect(traces.pathname).toBe('/traces-explorer');
    expect(traces.searchParams.get('relativeTime')).toBe('30m');

    const errors = new URL(links!.errors);
    expect(errors.pathname).toBe('/traces-explorer');
    expect(errors.searchParams.get('relativeTime')).toBe('30m');
    const errorsQuery = JSON.parse(errors.searchParams.get('compositeQuery')!);
    expect(errorsQuery.builder.queryData[0].filter.expression).toBe(
      `${expression} AND hasError = true`
    );
    expect(errorsQuery.id).toBe('signoz-observability-links-errors');
  });

  it('derives Pod and controller identity without guessing a multi-container name', () => {
    const links = buildSignalLinks(
      {
        cluster: 'prod',
        kind: 'Pod',
        jsonData: {
          kind: 'Pod',
          metadata: {
            name: 'api-abc-123',
            namespace: 'api',
            ownerReferences: [{ kind: 'ReplicaSet', name: 'api-abc', controller: true }],
          },
          spec: { containers: [{ name: 'api' }, { name: 'sidecar' }] },
        },
      },
      validateConfiguration(RAW_CONFIG)
    );
    const query = JSON.parse(new URL(links!.logs).searchParams.get('compositeQuery')!);
    const expression = query.builder.queryData[0].filter.expression;
    expect(expression).toContain("k8s.pod.name = 'api-abc-123'");
    expect(expression).toContain("k8s.replicaset.name = 'api-abc'");
    expect(expression).not.toContain('k8s.container.name');
  });

  it('escapes label values before constructing the query expression', () => {
    expect(correlationExpression([{ attribute: 'openplex.run.id', value: "run'\\unsafe" }])).toBe(
      "openplex.run.id = 'run\\'\\\\unsafe'"
    );
  });

  it.each([
    ['Node', { name: 'node-a' }, 'k8s.node.name'],
    ['Namespace', { name: 'demo' }, 'k8s.namespace.name'],
    ['Deployment', { name: 'api', namespace: 'demo' }, 'k8s.deployment.name'],
    ['Pod', { name: 'api-1', namespace: 'demo' }, 'k8s.pod.name'],
  ])('correlates %s by its own attribute', (kind, metadata, attribute) => {
    const links = buildSignalLinks(
      { cluster: 'prod', kind, metadata, jsonData: { kind, metadata } },
      validateConfiguration(RAW_CONFIG)
    );
    expect(links).not.toBeNull();
    const query = JSON.parse(new URL(links!.logs).searchParams.get('compositeQuery')!);
    expect(query.builder.queryData[0].filter.expression).toContain(attribute);
  });

  it.each(['Service', 'ConfigMap', 'ClusterRole'])(
    'suppresses %s, which has no telemetry identity',
    kind => {
      expect(
        buildSignalLinks(
          {
            cluster: 'prod',
            kind,
            jsonData: { kind, metadata: { name: 'thing', namespace: 'demo' } },
          },
          validateConfiguration(RAW_CONFIG)
        )
      ).toBeNull();
    }
  );
});
