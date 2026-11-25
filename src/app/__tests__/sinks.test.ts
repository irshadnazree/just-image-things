import { describe, expect, it } from 'vitest'
import { AsyncQueue, ZipSink } from '../sinks'

describe('AsyncQueue and ZipSink backpressure failure propagation', () => {
  it('rejects blocked and subsequent pushes when AsyncQueue fails', async () => {
    const queue = new AsyncQueue<number>()
    await queue.push(1)
    await queue.push(2)
    await queue.push(3)

    const blockedPush = queue.push(4)
    const diskError = new Error('Disk full')
    queue.fail(diskError)

    await expect(blockedPush).rejects.toThrow('Disk full')
    await expect(queue.push(5)).rejects.toThrow('Disk full')
  })

  it('unblocks ZipSink.write when createWritable rejects while queue is full', async () => {
    let rejectWritable: ((err: Error) => void) | null = null
    const fakeHandle = {
      createWritable: () =>
        new Promise<FileSystemWritableFileStream>((_resolve, reject) => {
          rejectWritable = reject
        }),
    } as unknown as FileSystemFileHandle

    const sink = ZipSink.fromHandle('frames.zip', fakeHandle)

    const writes: Array<Promise<unknown>> = []
    for (let i = 0; i < 6; i++) {
      writes.push(sink.write(`frame-${i}.png`, new Uint8Array([i, 1, 2, 3]).buffer))
    }

    await Promise.resolve()
    ;(rejectWritable as ((err: Error) => void) | null)?.(new Error('Permission denied'))

    const settled = await Promise.allSettled(writes)
    expect(settled.some((r) => r.status === 'rejected')).toBe(true)
    await expect(sink.write('late.png', new Uint8Array([9]).buffer)).rejects.toThrow('Permission denied')
    await expect(sink.finish()).rejects.toThrow('Permission denied')
  })

  it('unblocks ZipSink.write when pipeTo fails mid-archive', async () => {
    let chunkCount = 0
    const fakeWritable = new WritableStream<Uint8Array>({
      write() {
        chunkCount += 1
        if (chunkCount >= 1) {
          throw new Error('Quota exceeded')
        }
      },
    }) as unknown as FileSystemWritableFileStream

    const fakeHandle = {
      createWritable: () => Promise.resolve(fakeWritable),
    } as unknown as FileSystemFileHandle

    const sink = ZipSink.fromHandle('frames.zip', fakeHandle)

    let caught: unknown = null
    try {
      for (let i = 0; i < 12; i++) {
        await sink.write(`frame-${i}.png`, new Uint8Array(64).buffer)
      }
      await sink.finish()
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('Quota exceeded')
  })
})
