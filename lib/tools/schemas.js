/** Reusable output-schema fragments. */

import { S } from '../schema.js'

export const NULLABLE_STRING = S.oneOf([S.string(), S.null()])
export const NULLABLE_NUMBER = S.oneOf([S.number(), S.null()])
export const NULLABLE_INTEGER = S.oneOf([S.integer(), S.null()])
export const NULLABLE_BOOLEAN = S.oneOf([S.boolean(), S.null()])

export const ERROR_SCHEMA = S.object(
  {
    code: S.string({ required: true }),
    message: S.string({ required: true }),
    hint: NULLABLE_STRING,
    status: NULLABLE_INTEGER,
  },
  { additionalProperties: false },
)

export const PAGINATION_SCHEMA = S.object(
  {
    page: NULLABLE_INTEGER,
    perPage: NULLABLE_INTEGER,
    total: NULLABLE_INTEGER,
    totalPage: NULLABLE_INTEGER,
  },
  { additionalProperties: false },
)

export const USAGE_TOKENS_SCHEMA = S.object(
  {
    promptTokens: NULLABLE_INTEGER,
    completionTokens: NULLABLE_INTEGER,
    totalTokens: NULLABLE_INTEGER,
    cachedTokens: NULLABLE_INTEGER,
  },
  { additionalProperties: false },
)

export const CLUSTER_ROW_SCHEMA = S.object(
  {
    id: S.integer({ required: true }),
    name: S.string({ required: true }),
    provider: NULLABLE_STRING,
    state: NULLABLE_STRING,
    isDefault: NULLABLE_BOOLEAN,
    workers: NULLABLE_INTEGER,
    readyWorkers: NULLABLE_INTEGER,
    gpus: NULLABLE_INTEGER,
    models: NULLABLE_INTEGER,
    gatewayEndpoint: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

export const WORKER_ROW_SCHEMA = S.object(
  {
    id: S.integer({ required: true }),
    name: S.string({ required: true }),
    state: NULLABLE_STRING,
    ip: NULLABLE_STRING,
    port: NULLABLE_INTEGER,
    clusterId: NULLABLE_INTEGER,
    heartbeatTime: NULLABLE_STRING,
    unreachable: NULLABLE_BOOLEAN,
    maintenance: NULLABLE_BOOLEAN,
    gpuCount: NULLABLE_INTEGER,
    labels: S.array(S.string(), { required: true }),
  },
  { additionalProperties: false },
)

export const GPU_ROW_SCHEMA = S.object(
  {
    id: NULLABLE_STRING,
    uuid: NULLABLE_STRING,
    workerId: NULLABLE_INTEGER,
    workerName: NULLABLE_STRING,
    clusterId: NULLABLE_INTEGER,
    vendor: NULLABLE_STRING,
    type: NULLABLE_STRING,
    archFamily: NULLABLE_STRING,
    index: NULLABLE_INTEGER,
    name: NULLABLE_STRING,
    memoryBytes: NULLABLE_NUMBER,
    memoryGb: NULLABLE_NUMBER,
    memoryUsedBytes: NULLABLE_NUMBER,
    memoryUsedGb: NULLABLE_NUMBER,
    utilization: NULLABLE_NUMBER,
    driverVersion: NULLABLE_STRING,
    temperature: NULLABLE_NUMBER,
    power: NULLABLE_NUMBER,
  },
  { additionalProperties: false },
)

export const INSTANCE_ROW_SCHEMA = S.object(
  {
    id: S.integer({ required: true }),
    name: NULLABLE_STRING,
    state: NULLABLE_STRING,
    stateMessage: NULLABLE_STRING,
    workerId: NULLABLE_INTEGER,
    workerName: NULLABLE_STRING,
    port: NULLABLE_INTEGER,
    restartCount: NULLABLE_INTEGER,
    role: NULLABLE_STRING,
    gpuIndexes: S.array(S.any(), { required: true }),
  },
  { additionalProperties: false },
)

export const MODEL_ROW_SCHEMA = S.object(
  {
    id: S.integer({ required: true }),
    name: S.string({ required: true }),
    state: NULLABLE_STRING,
    readyReplicas: NULLABLE_INTEGER,
    replicas: NULLABLE_INTEGER,
    clusterId: NULLABLE_INTEGER,
    backend: NULLABLE_STRING,
    backendVersion: NULLABLE_STRING,
    source: NULLABLE_STRING,
    reference: NULLABLE_STRING,
    stateMessage: NULLABLE_STRING,
    restartingSince: NULLABLE_STRING,
    roleStatus: S.any(),
    createdAt: NULLABLE_STRING,
    backendParameters: S.array(S.string(), { required: true }),
    imageName: NULLABLE_STRING,
  },
  { additionalProperties: false },
)
