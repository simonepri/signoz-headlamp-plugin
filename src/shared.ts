/** Shared, browser-only safety helpers for independently bundled Headlamp plugins. */

const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_IDENTITY_VALUE_LENGTH = 512;

export type UnknownRecord = Record<string, unknown>;

export interface KubernetesResource {
  cluster?: unknown;
  kind?: unknown;
  metadata?: unknown;
  jsonData?: unknown;
}

export interface ResourceParts {
  cluster: string | null;
  kind: string | null;
  metadata: UnknownRecord;
  spec: UnknownRecord;
}

export interface CommonConfiguration {
  source: UnknownRecord;
  baseUrl: URL;
  allowedOrigins: string[];
  windowMinutes: number;
}

export interface CommonConfigurationPolicy {
  baseUrlField: string;
  maximumWindowMinutes: number;
  minimumWindowMinutes: number;
  schemaVersion: number;
}

export function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export function ownString(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTITY_VALUE_LENGTH ||
    hasControlCharacters(value)
  ) {
    return null;
  }
  return value;
}

export function optionalStringArray(value: unknown, label: string): string[] {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return [];
  }
  return stringArray(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error(`${label} must contain between 1 and 16 strings`);
  }
  const strings = value.map(entry => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 253) {
      throw new Error(`${label} contains an invalid string`);
    }
    return entry;
  });
  if (new Set(strings).size !== strings.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return strings;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function validatedBaseUrl(value: unknown, field: string): URL {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const baseUrl = new URL(value);
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error(`${field} must not contain credentials, query parameters, or a fragment`);
  }
  if (
    baseUrl.protocol !== 'https:' &&
    !(baseUrl.protocol === 'http:' && isLoopbackHostname(baseUrl.hostname))
  ) {
    throw new Error(`${field} must use HTTPS, except for browser loopback`);
  }
  return baseUrl;
}

function allowedWebOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('allowedOrigins entries must be bare origins without credentials');
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))
  ) {
    throw new Error('allowedOrigins entries must use HTTPS, except for browser loopback');
  }
  return url.origin;
}

function validatedAllowedOrigins(value: unknown, baseUrl: URL, field: string): string[] {
  const allowedOrigins = stringArray(value, 'allowedOrigins').map(allowedWebOrigin);
  if (!allowedOrigins.includes(baseUrl.origin)) {
    throw new Error(`${field} origin is not allowlisted`);
  }
  return allowedOrigins;
}

function validatedWindowMinutes(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`windowMinutes must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

export function validatedCommonConfiguration(
  value: unknown,
  policy: CommonConfigurationPolicy
): CommonConfiguration {
  const { baseUrlField, maximumWindowMinutes, minimumWindowMinutes, schemaVersion } = policy;
  if (!isRecord(value) || value.schemaVersion !== schemaVersion) {
    throw new Error(`configuration must use schemaVersion ${schemaVersion}`);
  }
  const baseUrl = validatedBaseUrl(value[baseUrlField], baseUrlField);
  return {
    source: value,
    baseUrl,
    allowedOrigins: validatedAllowedOrigins(value.allowedOrigins, baseUrl, baseUrlField),
    windowMinutes: validatedWindowMinutes(
      value.windowMinutes,
      minimumWindowMinutes,
      maximumWindowMinutes
    ),
  };
}

export function resourceParts(resource: KubernetesResource): ResourceParts {
  const jsonData = isRecord(resource.jsonData) ? resource.jsonData : {};
  const metadata = isRecord(resource.metadata)
    ? resource.metadata
    : isRecord(jsonData.metadata)
    ? jsonData.metadata
    : {};
  return {
    cluster: typeof resource.cluster === 'string' ? resource.cluster : null,
    kind:
      typeof resource.kind === 'string'
        ? resource.kind
        : typeof jsonData.kind === 'string'
        ? jsonData.kind
        : null,
    metadata,
    spec: isRecord(jsonData.spec) ? jsonData.spec : {},
  };
}

export function labelsFrom(value: unknown): UnknownRecord {
  if (!isRecord(value)) {
    return {};
  }
  return isRecord(value.labels) ? value.labels : {};
}

export function podTemplate(spec: UnknownRecord, kind: string | null): UnknownRecord {
  if (kind === 'CronJob' && isRecord(spec.jobTemplate)) {
    const jobSpec = isRecord(spec.jobTemplate.spec) ? spec.jobTemplate.spec : {};
    return isRecord(jobSpec.template) ? jobSpec.template : {};
  }
  return isRecord(spec.template) ? spec.template : {};
}

export function firstLabel(labels: UnknownRecord[], keys: string[]): string | null {
  for (const key of keys) {
    for (const source of labels) {
      const value = ownString(source, key);
      if (value !== null) {
        return value;
      }
    }
  }
  return null;
}

export async function loadJsonConfiguration<T>(
  url: string,
  validate: (value: unknown) => T,
  fetcher: typeof fetch = fetch
): Promise<T> {
  const response = await fetcher(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`configuration request failed with HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (contentLength > MAX_CONFIG_BYTES) {
    throw new Error('configuration exceeds the size limit');
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_CONFIG_BYTES) {
    throw new Error('configuration exceeds the size limit');
  }
  return validate(JSON.parse(body));
}

function pluginConfigurationUrl(
  pluginName: string,
  location: Pick<Location, 'origin'>,
  baseHref: string | null
): string {
  const applicationBase = new URL(baseHref ?? '/', `${location.origin}/`);
  return new URL(`static-plugins/${pluginName}/config.json`, applicationBase).toString();
}

export function pluginConfigurationUrlBuilder(
  pluginName: string
): (location?: Pick<Location, 'origin'>, baseHref?: string | null) => string {
  return (
    location: Pick<Location, 'origin'> = window.location,
    baseHref: string | null = document.querySelector('base')?.getAttribute('href') ?? null
  ) => pluginConfigurationUrl(pluginName, location, baseHref);
}

function updateFromPromise<T>(
  promise: Promise<T | null>,
  isActive: () => boolean,
  update: (value: T | null) => void
): void {
  promise
    .then(value => {
      if (isActive()) {
        update(value);
      }
    })
    .catch(() => {
      if (isActive()) {
        update(null);
      }
    });
}

export function updateWhileMounted<T>(
  promise: Promise<T | null>,
  update: (value: T | null) => void
): () => void {
  let active = true;
  updateFromPromise(promise, () => active, update);
  return () => {
    active = false;
  };
}

function memoizedPromise<T>(factory: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    promise ??= factory();
    return promise;
  };
}

export function configuredLinkBuilder<Resource, Configuration, Links>(
  loadConfiguration: () => Promise<Configuration>,
  buildLinks: (resource: Resource, configuration: Configuration) => Links | null
): (resource: Resource) => Promise<Links | null> {
  const configuration = memoizedPromise(loadConfiguration);
  return resource => configuration().then(value => buildLinks(resource, value));
}

export function hasAction(actions: ReadonlyArray<{ id?: string }>, pluginName: string): boolean {
  return actions.some(action => action.id === pluginName);
}

export function withActionInserted<Action extends { id?: string }>(
  actions: ReadonlyArray<Action>,
  action: Action,
  afterId: string
): Action[] {
  const inserted = [...actions];
  inserted.splice(inserted.findIndex(existing => existing.id === afterId) + 1, 0, action);
  return inserted;
}
