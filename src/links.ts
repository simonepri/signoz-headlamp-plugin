import type { KubernetesResource, UnknownRecord } from './shared';
import {
  firstLabel,
  isRecord,
  labelsFrom,
  loadJsonConfiguration,
  optionalStringArray,
  ownString,
  podTemplate,
  resourceParts,
  validatedCommonConfiguration,
} from './shared';

export const PLUGIN_NAME = 'signoz-observability-links';
const CONFIG_SCHEMA_VERSION = 1;
const MIN_WINDOW_MINUTES = 5;
const MAX_WINDOW_MINUTES = 360;

const SAFE_ATTRIBUTE = /^[A-Za-z_][A-Za-z0-9_.\-/]{0,254}$/;

export type { KubernetesResource } from './shared';

export interface LinkConfiguration {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  signozBaseUrl: string;
  allowedOrigins: string[];
  windowMinutes: number;
  correlation: {
    runLabelKeys: string[];
    runAttribute: string;
    containerLabelKeys: string[];
    containerAttribute: string;
  };
}

export interface CorrelationField {
  attribute: string;
  value: string;
}

export interface SignalLinks {
  errors: string;
  logs: string;
  metrics: string;
  traces: string;
}

interface ResourceIdentity {
  fields: CorrelationField[];
}

const WORKLOAD_ATTRIBUTES: Record<string, string> = {
  CronJob: 'k8s.cronjob.name',
  DaemonSet: 'k8s.daemonset.name',
  Deployment: 'k8s.deployment.name',
  Job: 'k8s.job.name',
  ReplicaSet: 'k8s.replicaset.name',
  StatefulSet: 'k8s.statefulset.name',
};

// Kinds whose identity maps to a telemetry query. Other resources would
// otherwise render cluster-wide links under a resource-specific title.
const CORRELATED_KINDS = new Set([...Object.keys(WORKLOAD_ATTRIBUTES), 'Namespace', 'Node', 'Pod']);

function validateAttribute(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ATTRIBUTE.test(value)) {
    throw new Error(`${label} is not a safe SigNoz attribute`);
  }
  return value;
}

export function validateConfiguration(value: unknown): LinkConfiguration {
  const common = validatedCommonConfiguration(value, {
    baseUrlField: 'signozBaseUrl',
    maximumWindowMinutes: MAX_WINDOW_MINUTES,
    minimumWindowMinutes: MIN_WINDOW_MINUTES,
    schemaVersion: CONFIG_SCHEMA_VERSION,
  });
  const source = common.source;
  if (!isRecord(source.correlation)) {
    throw new Error('correlation must be an object');
  }

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    signozBaseUrl: common.baseUrl.toString().replace(/\/$/, ''),
    allowedOrigins: common.allowedOrigins,
    windowMinutes: common.windowMinutes,
    correlation: {
      runLabelKeys: optionalStringArray(
        source.correlation.runLabelKeys,
        'correlation.runLabelKeys'
      ),
      runAttribute: validateAttribute(source.correlation.runAttribute, 'correlation.runAttribute'),
      containerLabelKeys: optionalStringArray(
        source.correlation.containerLabelKeys,
        'correlation.containerLabelKeys'
      ),
      containerAttribute: validateAttribute(
        source.correlation.containerAttribute,
        'correlation.containerAttribute'
      ),
    },
  };
}

function singleContainerName(spec: UnknownRecord): string | null {
  const containers = spec.containers;
  if (!Array.isArray(containers) || containers.length !== 1 || !isRecord(containers[0])) {
    return null;
  }
  return ownString(containers[0], 'name');
}

function put(fields: Map<string, string>, attribute: string, value: string | null): void {
  if (value !== null) {
    fields.set(attribute, value);
  }
}

function putPodController(fields: Map<string, string>, metadata: UnknownRecord): void {
  const owners = metadata.ownerReferences;
  if (!Array.isArray(owners)) {
    return;
  }
  const controller = owners.find(
    owner => isRecord(owner) && owner.controller === true && ownString(owner, 'kind')
  );
  if (!isRecord(controller)) {
    return;
  }
  const ownerKind = ownString(controller, 'kind');
  if (ownerKind && WORKLOAD_ATTRIBUTES[ownerKind]) {
    put(fields, WORKLOAD_ATTRIBUTES[ownerKind], ownString(controller, 'name'));
  }
}

interface ResourceIdentityInput {
  kind: string | null;
  name: string | null;
  metadata: UnknownRecord;
}

function putResourceIdentity(fields: Map<string, string>, input: ResourceIdentityInput): void {
  const { kind, metadata, name } = input;
  if (kind === 'Pod') {
    put(fields, 'k8s.pod.name', name);
    putPodController(fields, metadata);
  } else if (kind === 'Namespace') {
    put(fields, 'k8s.namespace.name', name);
  } else if (kind === 'Node') {
    put(fields, 'k8s.node.name', name);
  } else if (kind && WORKLOAD_ATTRIBUTES[kind]) {
    put(fields, WORKLOAD_ATTRIBUTES[kind], name);
  }
}

function identityFor(resource: KubernetesResource, config: LinkConfiguration): ResourceIdentity {
  const { cluster, kind, metadata, spec } = resourceParts(resource);
  const name = ownString(metadata, 'name');
  if (kind === null || !CORRELATED_KINDS.has(kind)) {
    return { fields: [] };
  }
  const fields = new Map<string, string>();
  put(fields, 'k8s.cluster.name', cluster);
  put(fields, 'k8s.namespace.name', ownString(metadata, 'namespace'));
  putResourceIdentity(fields, { kind, name, metadata });

  const template = podTemplate(spec, kind);
  const templateMetadata = isRecord(template.metadata) ? template.metadata : {};
  const labelSources = [labelsFrom(metadata), labelsFrom(templateMetadata)];
  put(
    fields,
    config.correlation.runAttribute,
    firstLabel(labelSources, config.correlation.runLabelKeys)
  );

  const templateSpec = isRecord(template.spec) ? template.spec : {};
  const container =
    firstLabel(labelSources, config.correlation.containerLabelKeys) ??
    singleContainerName(kind === 'Pod' ? spec : templateSpec);
  put(fields, config.correlation.containerAttribute, container);

  return {
    fields: Array.from(fields, ([attribute, value]) => ({ attribute, value })),
  };
}

function quoteExpressionValue(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function correlationExpression(fields: CorrelationField[]): string {
  return fields
    .map(({ attribute, value }) => `${attribute} = ${quoteExpressionValue(value)}`)
    .join(' AND ');
}

interface ExplorerQueryInput {
  signal: 'logs' | 'metrics' | 'traces';
  expression: string;
  metricName?: string;
  queryId: string;
}

function explorerQuery(input: ExplorerQueryInput): UnknownRecord {
  const { expression, metricName, queryId, signal } = input;
  const aggregations =
    signal === 'metrics'
      ? [
          {
            metricName,
            temporality: '',
            timeAggregation: 'avg',
            spaceAggregation: 'sum',
            reduceTo: 'avg',
          },
        ]
      : [];
  return {
    queryType: 'builder',
    builder: {
      queryData: [
        {
          queryName: 'A',
          dataSource: signal,
          aggregateOperator: 'noop',
          aggregations,
          functions: [],
          filter: { expression },
          filters: { items: [], op: 'AND' },
          expression,
          disabled: false,
          stepInterval: 60,
          having: { expression: '' },
          limit: null,
          orderBy:
            signal === 'logs'
              ? [
                  { columnName: 'timestamp', order: 'desc' },
                  { columnName: 'id', order: 'desc' },
                ]
              : [],
          groupBy: [],
          legend: '',
          reduceTo: 'avg',
        },
      ],
      queryFormulas: [],
      queryTraceOperator: [],
    },
    clickhouse_sql: [],
    promql: [],
    id: queryId,
  };
}

interface SignalUrlInput {
  config: LinkConfiguration;
  path: string;
  signal: 'logs' | 'metrics' | 'traces';
  expression: string;
  metricName?: string;
  queryId?: string;
}

function signalUrl(input: SignalUrlInput): string {
  const { config, expression, metricName, path, queryId, signal } = input;
  const url = new URL(`${config.signozBaseUrl}${path}`);
  url.searchParams.set(
    'compositeQuery',
    JSON.stringify(
      explorerQuery({
        signal,
        expression,
        metricName,
        queryId: queryId ?? `${PLUGIN_NAME}-${signal}`,
      })
    )
  );
  url.searchParams.set('panelType', signal === 'metrics' ? 'graph' : 'list');
  if (signal !== 'metrics') {
    url.searchParams.set('selectedExplorerView', 'list');
  }
  url.searchParams.set('relativeTime', `${config.windowMinutes}m`);
  return checkedDestination(url, config);
}

function metricsUrl(config: LinkConfiguration, identity: ResourceIdentity): string {
  const expression = correlationExpression(identity.fields);
  const metricName = identity.fields.some(
    ({ attribute }) => attribute === config.correlation.containerAttribute
  )
    ? 'container.cpu.usage'
    : identity.fields.some(({ attribute }) => attribute === 'k8s.node.name')
    ? 'k8s.node.cpu.usage'
    : 'k8s.pod.cpu.usage';
  return signalUrl({
    config,
    path: '/metrics-explorer/explorer',
    signal: 'metrics',
    expression,
    metricName,
  });
}

function checkedDestination(url: URL, config: LinkConfiguration): string {
  if (!config.allowedOrigins.includes(url.origin) || url.username || url.password) {
    throw new Error('generated destination is not allowlisted');
  }
  return url.toString();
}

export function buildSignalLinks(
  resource: KubernetesResource,
  configuration: LinkConfiguration
): SignalLinks | null {
  const identity = identityFor(resource, configuration);
  if (identity.fields.length === 0) {
    return null;
  }
  const expression = correlationExpression(identity.fields);
  return {
    // Error spans are the traces signal narrowed by SigNoz's boolean span field.
    errors: signalUrl({
      config: configuration,
      path: '/traces-explorer',
      signal: 'traces',
      expression: `${expression} AND hasError = true`,
      queryId: `${PLUGIN_NAME}-errors`,
    }),
    logs: signalUrl({
      config: configuration,
      path: '/logs/logs-explorer',
      signal: 'logs',
      expression,
    }),
    metrics: metricsUrl(configuration, identity),
    traces: signalUrl({
      config: configuration,
      path: '/traces-explorer',
      signal: 'traces',
      expression,
    }),
  };
}

/** Defaults used when the configuration comes from plugin settings. */
const DEFAULT_CORRELATION = {
  runLabelKeys: [],
  runAttribute: 'run.id',
  containerLabelKeys: [],
  containerAttribute: 'k8s.container.name',
};

export interface PluginSettings {
  baseUrl?: string;
  windowMinutes?: number;
}

/**
 * Builds a configuration from user-entered settings. The destination is
 * trusted only because the same user typed it, so it allowlists its own
 * origin. A deployed config.json always wins over this.
 */
export function configurationFromSettings(settings: unknown): LinkConfiguration {
  if (!isRecord(settings) || typeof settings.baseUrl !== 'string' || settings.baseUrl === '') {
    throw new Error('plugin settings do not define a SigNoz base URL');
  }
  return validateConfiguration({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    signozBaseUrl: settings.baseUrl,
    allowedOrigins: [new URL(settings.baseUrl).origin],
    windowMinutes: settings.windowMinutes ?? 30,
    correlation: DEFAULT_CORRELATION,
  });
}

export async function loadConfiguration(
  url: string,
  fetcher: typeof fetch = fetch
): Promise<LinkConfiguration> {
  return loadJsonConfiguration(url, validateConfiguration, fetcher);
}
