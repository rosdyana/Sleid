import { createJobQueue, type JobQueue } from '@sleid/jobs'

let queue: JobQueue | null = null
let starting: Promise<void> | null = null

/** The job queue, started once per process. Export jobs are sent here; the worker process receives them. */
export async function getJobQueue(): Promise<JobQueue> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required (see .env.example)')
  queue ??= createJobQueue(url, { maxConnections: 2 })
  starting ??= queue.start().catch((err: unknown) => {
    starting = null
    throw err
  })
  await starting
  return queue
}
