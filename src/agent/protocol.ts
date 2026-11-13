import type { EncodableFormat } from '../lib/formats.ts'
import type { Settings } from '../lib/settings.ts'

/** What the CLI hands the page: settings plus the files to fetch, in processing order. */
export interface AgentJob {
  settings: Settings
  files: { relPath: string; name: string; size: number }[]
}

export type AgentEvent =
  | { type: 'ready'; workers: number; userAgent: string }
  /** Sent every few seconds so the CLI can tell a busy page from a hung one. */
  | { type: 'heartbeat' }
  | { type: 'start'; index: number }
  | {
      type: 'done'
      index: number
      path: string
      size: number
      format: EncodableFormat
      width: number
      height: number
      kept: boolean
      skipped: boolean
    }
  | { type: 'error'; index: number; message: string }
  | { type: 'workers'; workers: number }
  | { type: 'finished' }
  /** Something went wrong outside a single file; logged, but the batch carries on. */
  | { type: 'log'; message: string }
  /** The batch could not run at all. */
  | { type: 'fatal'; message: string }

/** The CLI's reply to an output write, after applying the conflict policy on disk. */
export interface AgentWriteReply {
  path: string
  skipped: boolean
}

export const AGENT_TOKEN_HEADER = 'x-agent-token'
